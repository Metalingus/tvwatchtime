// Explicit live smoke test, restricted to the user-approved playground movie tvdb-369369.
// Run from repo root: node --env-file=.env apps/api/scripts/commsuni-write-smoke.mjs --run
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
if (!process.argv.includes('--run'))
  throw Error('Pass --run for the authorized playground movie write test');
const apiKey = process.env.COMMSUNI_API_KEY;
const secret = process.env.COMMSUNI_ACTOR_SECRET;
if (!apiKey || !secret) throw Error('Configure COMMSUNI_API_KEY and COMMSUNI_ACTOR_SECRET');
const target = '/entities/movie/tvdb-369369';
const runId = randomUUID();
const actor = (who) =>
  createHmac('sha256', secret)
    .update('write-smoke:' + runId + ':' + who)
    .digest('hex');
const report = {
  runId,
  target,
  startedAt: new Date().toISOString(),
  requests: [],
  checks: [],
  cleanup: [],
};
mkdirSync('.tmp', { recursive: true });
const reportPath = '.tmp/commsuni-write-smoke-' + runId + '.json';
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
const cleanup = [];
let requests = 0;
async function request(method, path, body, who = 'author', idempotencyKey, accepted = []) {
  if (++requests > 70) throw Error('Smoke request budget exceeded');
  if (!(
    path.startsWith(target + '/') ||
    path === '/authors/me/profile' ||
    /^\/comments\/[a-f0-9-]{36}(?:\/(?:replies|like|spoiler))?$/.test(path)
  ))
    throw Error('Unexpected smoke-test path');
  if (method !== 'GET') await delay(1100);
  const response = await fetch('https://api.commsuni.tv/v1' + path, {
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(12000),
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'X-TVTA-Actor-ID': actor(who),
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  const result = {
    method,
    path,
    status: response.status,
    code: data?.error?.code ?? (typeof data?.error === 'string' ? data.error : undefined),
    replayed: response.headers.get('idempotent-replayed'),
  };
  report.requests.push(result);
  save();
  console.log(JSON.stringify(result));
  if (!response.ok && !accepted.includes(response.status))
    throw Error(method + ' failed: ' + response.status + ' ' + (result.code ?? ''));
  return { status: response.status, data: data?.data ?? data };
}
async function observe(label, read, predicate) {
  const started = Date.now();
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt) await delay(2000);
    if (predicate(await read())) {
      report.checks.push({
        label,
        passed: true,
        reads: attempt + 1,
        elapsedMs: Date.now() - started,
      });
      save();
      return;
    }
  }
  check(label, false);
}
function check(label, valid) {
  report.checks.push({ label, passed: !!valid });
  save();
  if (!valid) throw Error('Check failed: ' + label);
}
try {
  await request('GET', target + '/comments?limit=1&sort=most_recent');
  if (!process.argv.includes('--engagement-only')) {
    await request('PUT', '/authors/me/profile', {
      displayName: 'TV Watch Time API Test',
      avatarUrl: null,
    });
    cleanup.push(['/authors/me/profile', 'author']);
    const body = {
      text: 'TV Watch Time integration smoke test ' + runId,
      language: 'en',
      createdAt: new Date().toISOString(),
    };
    const operation = randomUUID();
    report.createOperation = { idempotencyKey: operation, body };
    save();
    const posted = await request('POST', target + '/comments', body, 'author', operation);
    const parent = posted.data?.comment?.id;
    check('create returns a native comment ID', /^[a-f0-9-]{36}$/.test(parent ?? ''));
    cleanup.push(['/comments/' + parent, 'author']);
    const replay = await request('POST', target + '/comments', body, 'author', operation);
    check('idempotent retry returns the same ID', replay.data?.comment?.id === parent);
    const read = await request('GET', '/comments/' + parent);
    check(
      'comment GET preserves text and source',
      read.data?.comment?.text === body.text &&
        read.data?.comment?.origin?.slug === process.env.COMMSUNI_SOURCE_SLUG,
    );
    await observe(
      'new comment appears in the feed',
      () => request('GET', target + '/comments?limit=10&sort=most_recent'),
      (page) => page.data?.comments?.some((item) => item.id === parent && !item.deleted),
    );
    const replyBody = {
      text: 'TV Watch Time test reply ' + runId,
      language: 'en',
      createdAt: new Date().toISOString(),
    };
    const replyKey = randomUUID();
    report.replyOperation = { idempotencyKey: replyKey, body: replyBody, parent };
    save();
    const reply = await request(
      'POST',
      '/comments/' + parent + '/replies',
      replyBody,
      'author',
      replyKey,
    );
    const child = reply.data?.comment?.id;
    check('reply returns an ID', /^[a-f0-9-]{36}$/.test(child ?? ''));
    cleanup.push(['/comments/' + child, 'author']);
    await observe(
      'reply GET preserves parent and content',
      () => request('GET', '/comments/' + parent + '/replies'),
      (replies) =>
        replies.data?.replies?.some((item) => item.id === child && item.text === replyBody.text),
    );
    await request('PUT', '/comments/' + parent + '/like', undefined, 'viewer');
    cleanup.push(['/comments/' + parent + '/like', 'viewer']);
    check(
      'like reads back for the actor',
      (await request('GET', '/comments/' + parent, undefined, 'viewer')).data?.comment
        ?.viewerLiked === true,
    );
    await request('DELETE', '/comments/' + parent + '/like', undefined, 'viewer');
    cleanup.pop();
    check(
      'unlike reads back',
      (await request('GET', '/comments/' + parent, undefined, 'viewer')).data?.comment
        ?.viewerLiked === false,
    );
    await request('PATCH', '/comments/' + parent, { isSpoiler: true });
    check(
      'author spoiler flag reads back',
      (await request('GET', '/comments/' + parent)).data?.comment?.isSpoiler === true,
    );
    await request('PATCH', '/comments/' + parent, { isSpoiler: false });
    await request('PUT', '/comments/' + parent + '/spoiler', undefined, 'viewer');
    cleanup.push(['/comments/' + parent + '/spoiler', 'viewer']);
    check(
      'community spoiler mark reads back',
      (await request('GET', '/comments/' + parent, undefined, 'viewer')).data?.comment
        ?.viewerMarkedSpoiler === true,
    );
    await request('DELETE', '/comments/' + parent + '/spoiler', undefined, 'viewer');
    cleanup.pop();
  }
  const engagement = await request('GET', target + '/engagement');
  const stars = engagement.data?.options?.starRatings ?? [];
  const kind = stars.length ? 'star_rating' : 'emotion';
  const option =
    stars.find((item) => item.stars === 5) ?? stars[0] ?? engagement.data?.options?.emotions?.[0];
  if (option?.key) {
    await request('PUT', target + '/engagement/' + kind, { optionKey: option.key });
    cleanup.push([target + '/engagement/' + kind, 'author', { optionKey: option.key }]);
    const voted = await request('GET', target + '/engagement');
    const options = voted.data?.options?.[kind === 'star_rating' ? 'starRatings' : 'emotions'];
    check(
      kind + ' vote reads back',
      options?.some((item) => item.key === option.key && item.viewerSelected),
    );
  } else
    report.checks.push({
      label: 'engagement vote',
      skipped: 'Playground movie exposes no vote options',
    });
  const counts = await request('GET', target + '/conversation');
  check('conversation GET returns counts', Number.isInteger(counts.data?.comments?.total));
} catch (error) {
  report.error = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const [path, who, body] of cleanup.reverse()) {
    try {
      await request('DELETE', path, body, who, undefined, [404]);
      report.cleanup.push({ path, ok: true });
    } catch (error) {
      report.cleanup.push({ path, ok: false, error: error.message });
      process.exitCode = 1;
    }
  }
  report.finishedAt = new Date().toISOString();
  save();
  console.log(
    JSON.stringify({
      report: reportPath,
      passed: report.checks.filter((c) => c.passed).length,
      failed: report.checks.filter((c) => c.passed === false).length,
      cleanupPending: report.cleanup.filter((c) => !c.ok).length,
    }),
  );
}
