#!/usr/bin/env node
// Operator-only client. Never starts NestJS, a worker, Prisma, or a provider connection.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export function apiBase(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash)
    throw new Error('Use an API base URL without credentials, query, or fragment');
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new Error('HTTPS is required except on loopback');
  return url.href.replace(/\/+$/, '');
}

export function orderedRows(rows) {
  const eligible = rows.filter((row) => row.status === 'eligible');
  const byId = new Map(eligible.map((row) => [row.commentId, row]));
  if (byId.size !== eligible.length) throw new Error('Manifest contains duplicate comments');
  const ordered = [],
    visiting = new Set(),
    visited = new Set();
  const visit = (row) => {
    if (visited.has(row.commentId)) return;
    if (visiting.has(row.commentId)) throw new Error('Manifest contains a reply cycle');
    visiting.add(row.commentId);
    const parent = byId.get(row.parentId);
    if (parent) visit(parent);
    visiting.delete(row.commentId);
    visited.add(row.commentId);
    ordered.push(row);
  };
  eligible.forEach(visit);
  return ordered;
}

export async function saveManifest(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}

export function requester(base, token, transport = fetch) {
  if (!token?.trim()) throw new Error('Set COMMSUNI_ADMIN_TOKEN to an administrator JWT');
  return async (path, body) => {
    const response = await transport(base + '/admin/commsuni/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: 'Bearer ' + token.trim(),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120000),
      redirect: 'error',
    });
    // Do not echo error bodies: they may contain comment text or sensitive diagnostics.
    if (!response.ok)
      throw new Error(
        'Administrator API returned HTTP ' + response.status + '; inspect server/admin diagnostics',
      );
    return response.json();
  };
}

export async function reportRun(request, manifest) {
  const operations = [];
  let cursor;
  let page;
  do {
    page = await request(
      'backfill/runs/' + manifest.runId + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
    );
    operations.push(...page.operations);
    if (page.nextCursor === cursor) throw new Error('Report cursor did not advance');
    cursor = page.nextCursor;
  } while (cursor);
  return {
    runId: manifest.runId,
    states: page.states,
    writePausedUntil: page.writePausedUntil,
    operations,
  };
}

export async function preview(request, manifest, persist) {
  if (manifest.complete) return;
  do {
    const params = new URLSearchParams({
      runId: manifest.runId,
      cutoff: manifest.cutoff,
      limit: '50',
    });
    if (manifest.cursor) params.set('cursor', manifest.cursor);
    const page = await request('backfill/preview?' + params);
    if (
      page.runId !== manifest.runId ||
      page.cutoff !== manifest.cutoff ||
      (manifest.connectionScope && page.connectionScope !== manifest.connectionScope)
    )
      throw new Error('Preview identity or connection scope changed');
    manifest.connectionScope = page.connectionScope;
    if (page.sourceCounts) manifest.sourceCounts = page.sourceCounts;
    manifest.rows.push(...page.rows);
    if (page.nextCursor && page.nextCursor === manifest.cursor)
      throw new Error('Preview cursor did not advance');
    manifest.cursor = page.nextCursor;
    manifest.complete = !page.nextCursor;
    await persist(manifest);
  } while (!manifest.complete);
}

export async function apply(
  request,
  manifest,
  persist,
  { acknowledge = false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {},
) {
  if (!acknowledge)
    throw new Error('Review the manifest, then use --acknowledge-historical-sharing with --apply');
  if (!manifest.complete) throw new Error('Finish the dry run before applying');
  const ready = await request('backfill/readiness');
  if (ready.connectionScope !== manifest.connectionScope)
    throw new Error('Connection scope changed; do not regenerate or replay this run');
  if (
    ready.missing.length ||
    !ready.writesEnabled ||
    !ready.backfillEnabled ||
    ready.writePausedUntil
  )
    throw new Error('Backfill readiness failed; inspect the administrator readiness endpoint');
  const rows = orderedRows(manifest.rows);
  manifest.results ??= {};
  // Each batch is acknowledged before admitting more; the server additionally bounds concurrent operators.
  for (let offset = 0; offset < rows.length; offset += 5) {
    const batch = rows.slice(offset, offset + 5);
    const result = await request('backfill/enqueue', {
      runId: manifest.runId,
      cutoff: manifest.cutoff,
      acknowledgeHistoricalSharing: true,
      entries: batch.map(({ commentId, proof }) => ({ commentId, proof })),
    });
    for (const row of result.results) manifest.results[row.commentId] = row;
    await persist(manifest);
    if (
      result.results.length !== batch.length ||
      result.results.some((row) => !['queued', 'existing'].includes(row.status))
    )
      throw new Error(
        'Backfill paused on an excluded, changed, or deferred comment; inspect the checkpoint before resuming',
      );
    for (;;) {
      // Poll only this batch, including any pre-existing live operation. Export the full run once at the end.
      const operations = await Promise.all(
        batch.map((row) =>
          request('operations/' + encodeURIComponent(manifest.results[row.commentId].operationId)),
        ),
      );
      for (let i = 0; i < batch.length; i++) {
        const saved = manifest.results[batch[i].commentId];
        if (operations[i].id !== saved.operationId) throw new Error('Operation identity mismatch');
        Object.assign(saved, {
          state: operations[i].state,
          remoteId: operations[i].remoteId,
          errorCode: operations[i].errorCode,
          providerError: operations[i].providerError,
        });
      }
      await persist(manifest);
      if (
        operations.some(
          (row) => row.state !== 'SYNCED' && row.providerError?.reason === 'daily_budget',
        )
      )
        throw new Error(
          'Provider daily budget paused; retain this manifest and resume after review',
        );
      if (operations.every((row) => row.state === 'SYNCED')) break;
      if (
        operations.some(
          (row) => !['PENDING', 'RETRY', 'SENDING', 'WAITING_PARENT'].includes(row.state),
        )
      )
        throw new Error(
          'Delivery requires review; inspect the saved checkpoint and administrator operations before resuming',
        );
      await sleep(5000);
    }
  }
  manifest.report = await reportRun(request, manifest);
  manifest.deliveryComplete = true;
  await persist(manifest);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (['--apply', '--report', '--acknowledge-historical-sharing'].includes(key))
      options[key] = true;
    else if (
      ['--api-url', '--manifest', '--cutoff'].includes(key) &&
      argv[i + 1] &&
      !argv[i + 1].startsWith('--')
    )
      options[key] = argv[++i];
    else
      throw new Error(
        'Usage: node commsuni-backfill.mjs --api-url https://backend/api --manifest private-run.json [--cutoff ISO] [--apply --acknowledge-historical-sharing | --report]',
      );
  }
  if (
    !options['--api-url'] ||
    !options['--manifest'] ||
    (options['--apply'] && options['--report'])
  )
    throw new Error('Provide --api-url and --manifest, and at most one action');
  const base = apiBase(options['--api-url']);
  const path = resolve(options['--manifest']);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' || options['--apply'] || options['--report']) throw error;
    manifest = {
      version: 1,
      apiUrl: base,
      runId: randomUUID(),
      cutoff: options['--cutoff'] || new Date(Date.now() - 5000).toISOString(),
      complete: false,
      rows: [],
    };
    // Reserve the path: a concurrent operator must not overwrite a different run.
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
  }
  if (manifest.version !== 1 || manifest.apiUrl !== base || !Array.isArray(manifest.rows))
    throw new Error('Manifest does not match this API');
  if (options['--cutoff'] && options['--cutoff'] !== manifest.cutoff)
    throw new Error('Use the original fixed cutoff');
  const request = requester(base, env.COMMSUNI_ADMIN_TOKEN);
  const persist = (data) => saveManifest(path, data);
  if (options['--report']) {
    manifest.report = await reportRun(request, manifest);
    await persist(manifest);
  } else if (options['--apply']) {
    await apply(request, manifest, persist, {
      acknowledge: options['--acknowledge-historical-sharing'] === true,
    });
  } else {
    await preview(request, manifest, persist);
  }
  console.log(
    JSON.stringify({
      runId: manifest.runId,
      reviewed: manifest.rows.length,
      eligible: manifest.rows.filter((row) => row.status === 'eligible').length,
      deliveryComplete: manifest.deliveryComplete === true,
      states: manifest.report?.states,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
