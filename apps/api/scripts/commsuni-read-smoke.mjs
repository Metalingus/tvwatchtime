// Explicitly opt-in. No dotenv loading, no write method, no synthetic write/cleanup test.
import { createHmac } from 'node:crypto';
const base = 'https://api.commsuni.tv/v1';
const allowed =
  /^\/(health|sources|entities\/(show|movie|episode|season)\/[a-z0-9:-]+\/(comments|conversation|engagement)|comments\/[a-f0-9-]+\/(replies|media))$/i;
if (process.env.COMMSUNI_LIVE_READS !== 'true')
  throw new Error('Set COMMSUNI_LIVE_READS=true to run bounded production GET checks');
const key = process.env.COMMSUNI_API_KEY;
const secret = process.env.COMMSUNI_ACTOR_SECRET;
const type = process.env.COMMSUNI_SMOKE_TYPE;
const ref = process.env.COMMSUNI_SMOKE_REF;
if (
  !key ||
  !secret ||
  secret.length < 32 ||
  !['show', 'movie', 'episode', 'season'].includes(type) ||
  !/^tvdb-[1-9]\d*(?:-s\d+(?:e\d+)?)?$/.test(ref || '')
) {
  throw new Error(
    'Provide a read key, actor secret, and a reviewed COMMSUNI_SMOKE_TYPE/COMMSUNI_SMOKE_REF',
  );
}
let remaining = 8;
const actor = createHmac('sha256', secret).update('tvwatch-read-smoke').digest('hex');
async function get(path, query = {}) {
  if (!allowed.test(path) || remaining-- <= 0)
    throw new Error('Live read allowlist or request budget exceeded');
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
    headers: {
      Authorization: 'Bearer ' + key,
      'X-TVTA-Actor-ID': actor,
      Accept: 'application/json',
    },
  });
  // No comment text, personas, credentials, bodies, or signed URLs in output.
  console.log(
    JSON.stringify({
      path,
      status: response.status,
      metric: response.headers.get('x-ratelimit-metric'),
      remaining: response.headers.get('ratelimit-remaining'),
    }),
  );
  if (response.status === 429 || response.status === 401 || response.status === 403)
    throw new Error('Live checks stopped on provider access/rate response');
  return response.json().catch(() => null);
}
await get('/health');
await get('/sources');
const entityPath = '/entities/' + type + '/' + ref;
const page = await get(entityPath + '/comments', { limit: 5, sort: 'most_recent' });
await get(entityPath + '/engagement');
await get(entityPath + '/conversation');
if (page?.data?.nextCursor)
  await get(entityPath + '/comments', {
    limit: 5,
    sort: 'most_recent',
    cursor: page.data.nextCursor,
  });
const first = page?.data?.comments?.[0]?.id;
if (/^[a-f0-9-]{36}$/i.test(first || ''))
  await get('/comments/' + first + '/replies', { limit: 5 });
