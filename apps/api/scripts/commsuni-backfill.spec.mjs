import test from 'node:test';
import assert from 'node:assert/strict';
import {
  apiBase,
  orderedRows,
  preview,
  apply,
  requester,
  reportRun,
} from './commsuni-backfill.mjs';
const make = () => ({
  version: 1,
  runId: 'run',
  cutoff: '2026-01-01T00:00:00Z',
  rows: [],
  complete: false,
});
test('rejects insecure or credential-bearing API destinations', () => {
  assert.equal(apiBase('http://localhost:4000/api/'), 'http://localhost:4000/api');
  for (const url of [
    'http://public.example/api',
    'https://user:pass@example.com/api',
    'https://example.com/api?token=x',
  ])
    assert.throws(() => apiBase(url));
});
test('orders parents before children and rejects cycles', () => {
  const row = (id, parentId) => ({ commentId: id, parentId, status: 'eligible' });
  assert.deepEqual(
    orderedRows([row('child', 'parent'), row('parent')]).map((r) => r.commentId),
    ['parent', 'child'],
  );
  assert.throws(() => orderedRows([row('a', 'b'), row('b', 'a')]));
});
test('dry run only performs GET requests, saves every page, and resumes its cursor', async () => {
  const m = make();
  const saved = [];
  const calls = [];
  const request = async (path, body) => {
    calls.push(path);
    assert.equal(body, undefined);
    return {
      runId: m.runId,
      cutoff: m.cutoff,
      connectionScope: 'scope',
      rows: [{ commentId: String(calls.length) }],
      nextCursor: calls.length === 1 ? 'next' : null,
    };
  };
  await preview(request, m, async (value) => saved.push(structuredClone(value)));
  assert.equal(saved.length, 2);
  assert.equal(m.complete, true);
  assert.match(calls[1], /cursor=next/);
});
test('apply requires explicit sharing acknowledgement before any request', async () => {
  await assert.rejects(
    () =>
      apply(
        () => {
          throw Error('must not call');
        },
        make(),
        async () => {},
      ),
    /acknowledge/,
  );
});
test('apply refuses a different provider connection scope', async () => {
  const m = { ...make(), complete: true, connectionScope: 'old' };
  await assert.rejects(
    () =>
      apply(
        async () => ({ connectionScope: 'new' }),
        m,
        async () => {},
        { acknowledge: true },
      ),
    /scope changed/,
  );
});
test('apply checkpoints stable IDs and waits for acknowledgement, then resumes using the same manifest', async () => {
  const m = {
    ...make(),
    complete: true,
    connectionScope: 'scope',
    rows: [{ status: 'eligible', commentId: 'one', proof: 'proof' }],
  };
  const posts = [];
  const request = async (path, body) => {
    if (path === 'backfill/readiness')
      return { connectionScope: 'scope', missing: [], writesEnabled: true, backfillEnabled: true };
    if (path.startsWith('operations/'))
      return { id: 'stable', state: 'SYNCED', remoteId: 'remote' };
    if (body) {
      posts.push(body);
      return {
        results: [{ commentId: 'one', operationId: 'stable', status: 'existing', state: 'SYNCED' }],
      };
    }
    return {
      operations: [{ id: 'stable', state: 'SYNCED', remoteId: 'remote' }],
      states: [{ state: 'SYNCED', count: 1 }],
      nextCursor: null,
    };
  };
  await apply(request, m, async () => {}, { acknowledge: true });
  await apply(request, m, async () => {}, { acknowledge: true });
  assert.deepEqual(posts[0], posts[1]);
  assert.equal(m.deliveryComplete, true);
});
test('requires review for uncertain delivery and never reports completion', async () => {
  const m = {
    ...make(),
    complete: true,
    connectionScope: 'scope',
    rows: [{ status: 'eligible', commentId: 'one', proof: 'proof' }],
  };
  const request = async (path, body) =>
    path === 'backfill/readiness'
      ? { connectionScope: 'scope', missing: [], writesEnabled: true, backfillEnabled: true }
      : body
        ? {
            results: [
              { commentId: 'one', operationId: 'op', status: 'existing', state: 'UNCERTAIN' },
            ],
          }
        : { id: 'op', state: 'UNCERTAIN' };
  await assert.rejects(
    () => apply(request, m, async () => {}, { acknowledge: true }),
    /requires review/,
  );
  assert.notEqual(m.deliveryComplete, true);
});
test('paginates all operation mappings', async () => {
  let n = 0;
  const report = await reportRun(
    async () => ({ operations: [{ id: ++n }], states: [], nextCursor: n === 1 ? '100' : null }),
    make(),
  );
  assert.equal(report.operations.length, 2);
});
test('never follows redirects with the administrator token', async () => {
  const request = requester('https://api.example/api', 'fake', async (_url, opts) => {
    assert.equal(opts.redirect, 'error');
    assert.equal(opts.method, 'GET');
    return { ok: true, json: async () => ({}) };
  });
  await request('backfill/readiness');
});
