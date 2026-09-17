import { execFileSync } from 'child_process';
import { localCommentCountQuery } from './commsuni.comment-count.sql';

// Opt-in local PostgreSQL check. SELECT-only fixtures shadow the real comments table.
const container = process.env.COMMSUNI_SQL_TEST_CONTAINER;
const postgres = container ? describe : describe.skip;
const entity = '11111111-1111-4111-8111-111111111111';
const commentId = '22222222-2222-4222-8222-222222222222';
const row = (over: Record<string, unknown> = {}) => ({
  id: 'local',
  thread_type: 'EPISODE',
  thread_id: 'episode',
  source: 'MANUAL',
  source_key: null,
  has_local_revision: false,
  commsuni_comment_id: null,
  commsuni_entity_id: null,
  commsuni_origin_id: null,
  commsuni_state: null,
  parent_id: null,
  commsuni_parent_id: null,
  external_review_id: null,
  hidden: false,
  admin_deleted: false,
  deleted_by_user: false,
  ...over,
});
const linked = { commsuni_comment_id: commentId, commsuni_entity_id: entity };
function query(rows: Record<string, unknown>[], repeats = 1, threadId = 'episode') {
  const quote = (value: unknown) => "'" + String(value).replace(/'/g, "''") + "'";
  const q = localCommentCountQuery('EPISODE', threadId, entity);
  const bound = q.text.replace(/\$(\d+)/g, (_, index) => quote(q.values[Number(index) - 1]));
  const fixtures =
    'comments AS (SELECT x.* FROM jsonb_to_recordset(' +
    quote(JSON.stringify(rows)) +
    ') AS x(id text, thread_type "CommentThreadType", thread_id text, source text, source_key text,' +
    ' has_local_revision boolean, commsuni_comment_id text, commsuni_entity_id text, commsuni_origin_id text,' +
    ' commsuni_state text, parent_id text, commsuni_parent_id text, external_review_id text,' +
    ' hidden boolean, admin_deleted boolean, deleted_by_user boolean)' +
    ' CROSS JOIN generate_series(1, ' +
    repeats +
    '))';
  return bound.replace(/WITH candidates/, 'WITH ' + fixtures + ', candidates');
}
function run(sql: string) {
  return execFileSync(
    'rtk',
    [
      'proxy',
      'docker',
      'exec',
      '-i',
      container!,
      'sh',
      '-c',
      'exec psql -X -q -t -A -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
    ],
    { input: sql + ';', encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 },
  ).trim();
}
postgres('PostgreSQL local comment-count aggregate', () => {
  it.each([
    ['empty', [], '0|f'],
    ['local', [row()], '1|f'],
    ['linked', [row(linked)], '0|f'],
    [
      'structural copy',
      [
        row({ id: 'original', thread_id: 'other', ...linked }),
        row({ id: 'copy', commsuni_origin_id: 'original' }),
      ],
      '0|f',
    ],
    ['unmatched import', [row({ source: 'TVTIME', source_key: 'tvtime|' + commentId })], '1|t'],
    ['edited import', [row({ source: 'TVTIME', has_local_revision: true, ...linked })], '1|f'],
    ['edited original', [row({ has_local_revision: true, ...linked })], '0|f'],
    [
      'edited copy',
      [
        row({ id: 'original', thread_id: 'other', ...linked }),
        row({ id: 'copy', has_local_revision: true, commsuni_origin_id: 'original' }),
      ],
      '1|f',
    ],
    ['legacy null source', [row({ source: null })], '1|f'],
    ['invalid remote ID', [row({ ...linked, commsuni_comment_id: 'invalid' })], '1|f'],
    ['wrong entity', [row({ ...linked, commsuni_entity_id: commentId })], '1|f'],
    ['unacknowledged delivery', [row({ commsuni_state: 'SENDING' })], '1|t'],
    ['reply', [row({ parent_id: 'parent' })], '0|f'],
    ['shared reply', [row({ commsuni_parent_id: commentId })], '0|f'],
    ['review reply', [row({ external_review_id: 'review' })], '0|f'],
    ['hidden', [row({ hidden: true })], '0|f'],
    ['admin deleted', [row({ admin_deleted: true })], '0|f'],
    ['user deleted', [row({ deleted_by_user: true })], '0|f'],
  ] as const)('%s retains the existing count semantics', (_name, rows, expected) => {
    expect(run(query([...rows]))).toBe(expected);
  });

  it('binds a thread identifier containing SQL punctuation as data', () => {
    expect(run(query([row()], 1, "episode' OR 1=1 --"))).toBe('0|f');
  });

  it('returns one aggregate row for 50,000 local comments', () => {
    const sql = query([row()], 50_000);
    expect(run(sql)).toBe('50000|f');
    const [plan] = JSON.parse(run('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql));
    expect(plan.Plan['Actual Rows']).toBe(1);
    console.info('Synthetic 50k-comment SQL execution ms:', plan['Execution Time']);
  });
});
