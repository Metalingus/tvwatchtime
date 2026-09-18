import { utcFromZoned, zonedParts } from '../../common/utils/timezone.util';

export interface TvdbBroadcastSchedule {
  airTime: string;
  timeZone: string;
  /** Previous production-country rule, only for recognizing timestamps this bug wrote. */
  legacyTimeZone?: string;
}

/**
 * TVDB's series schedule convention: US Eastern, otherwise capital/most populous city.
 * https://support.thetvdb.com/kb/faq.php?id=29
 * IANA zones preserve historical daylight-saving rules; never use a fixed UTC offset.
 */
const COUNTRY_ZONES: Record<string, string> = {
  usa: 'America/New_York',
  us: 'America/New_York',
  can: 'America/Toronto',
  ca: 'America/Toronto',
  gbr: 'Europe/London',
  gb: 'Europe/London',
  irl: 'Europe/Dublin',
  ie: 'Europe/Dublin',
  fra: 'Europe/Paris',
  fr: 'Europe/Paris',
  deu: 'Europe/Berlin',
  de: 'Europe/Berlin',
  ita: 'Europe/Rome',
  it: 'Europe/Rome',
  esp: 'Europe/Madrid',
  es: 'Europe/Madrid',
  prt: 'Europe/Lisbon',
  pt: 'Europe/Lisbon',
  nld: 'Europe/Amsterdam',
  nl: 'Europe/Amsterdam',
  bel: 'Europe/Brussels',
  be: 'Europe/Brussels',
  swe: 'Europe/Stockholm',
  se: 'Europe/Stockholm',
  nor: 'Europe/Oslo',
  no: 'Europe/Oslo',
  dnk: 'Europe/Copenhagen',
  dk: 'Europe/Copenhagen',
  fin: 'Europe/Helsinki',
  fi: 'Europe/Helsinki',
  pol: 'Europe/Warsaw',
  pl: 'Europe/Warsaw',
  cze: 'Europe/Prague',
  cz: 'Europe/Prague',
  hun: 'Europe/Budapest',
  hu: 'Europe/Budapest',
  rou: 'Europe/Bucharest',
  ro: 'Europe/Bucharest',
  grc: 'Europe/Athens',
  gr: 'Europe/Athens',
  tur: 'Europe/Istanbul',
  tr: 'Europe/Istanbul',
  rus: 'Europe/Moscow',
  ru: 'Europe/Moscow',
  ukr: 'Europe/Kyiv',
  ua: 'Europe/Kyiv',
  jpn: 'Asia/Tokyo',
  jp: 'Asia/Tokyo',
  kor: 'Asia/Seoul',
  kr: 'Asia/Seoul',
  chn: 'Asia/Shanghai',
  cn: 'Asia/Shanghai',
  twn: 'Asia/Taipei',
  tw: 'Asia/Taipei',
  hkg: 'Asia/Hong_Kong',
  hk: 'Asia/Hong_Kong',
  ind: 'Asia/Kolkata',
  in: 'Asia/Kolkata',
  sgp: 'Asia/Singapore',
  sg: 'Asia/Singapore',
  mys: 'Asia/Kuala_Lumpur',
  my: 'Asia/Kuala_Lumpur',
  tha: 'Asia/Bangkok',
  th: 'Asia/Bangkok',
  phl: 'Asia/Manila',
  ph: 'Asia/Manila',
  aus: 'Australia/Sydney',
  au: 'Australia/Sydney',
  nzl: 'Pacific/Auckland',
  nz: 'Pacific/Auckland',
  bra: 'America/Sao_Paulo',
  br: 'America/Sao_Paulo',
  mex: 'America/Mexico_City',
  mx: 'America/Mexico_City',
  arg: 'America/Argentina/Buenos_Aires',
  ar: 'America/Argentina/Buenos_Aires',
  chl: 'America/Santiago',
  cl: 'America/Santiago',
  col: 'America/Bogota',
  co: 'America/Bogota',
  per: 'America/Lima',
  pe: 'America/Lima',
  zaf: 'Africa/Johannesburg',
  za: 'Africa/Johannesburg',
  nga: 'Africa/Lagos',
  ng: 'Africa/Lagos',
  egy: 'Africa/Cairo',
  eg: 'Africa/Cairo',
  isr: 'Asia/Jerusalem',
  il: 'Asia/Jerusalem',
  sau: 'Asia/Riyadh',
  sa: 'Asia/Riyadh',
  are: 'Asia/Dubai',
  ae: 'Asia/Dubai',
};

// TVDB documents these streaming schedules in US Eastern, independently of
// a show's production country. Prime has its separate official GMT-date rule.
export const TVDB_EASTERN_STREAMING_NETWORKS = [
  'Apple TV',
  'Apple TV+',
  'Apple TV Plus',
  'Netflix',
  'Disney+',
  'Hulu',
  'HBO Max',
  'Max',
  'Paramount+',
  'AMC+',
  'ALLBLK',
  'BET+',
  'Peacock',
] as const;

export function tvdbBroadcastSchedule(series: {
  airsTime?: string | null;
  originalCountry?: string | null;
  originalNetwork?: { name?: string | null; country?: string | null } | null;
}): TvdbBroadcastSchedule | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(series.airsTime?.trim() ?? '');
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  const airTime = match[1].padStart(2, '0') + ':' + match[2];
  // TVDB explicitly keeps Prime's official date in GMT, even when its clock is
  // entered as 19:00/20:00 Eastern on the preceding day. Do not shift that date twice.
  if (
    /^(amazon|amazon prime video|prime video)$/i.test(series.originalNetwork?.name?.trim() ?? '')
  ) {
    return ['00:00', '19:00', '20:00'].includes(airTime)
      ? { airTime: '00:00', timeZone: 'UTC' }
      : null;
  }
  const productionZone = COUNTRY_ZONES[series.originalCountry?.trim().toLowerCase() ?? ''];
  const networkName = series.originalNetwork?.name?.trim().toLowerCase();
  if (TVDB_EASTERN_STREAMING_NETWORKS.some((name) => name.toLowerCase() === networkName)) {
    return {
      airTime,
      timeZone: 'America/New_York',
      ...(productionZone && productionZone !== 'America/New_York'
        ? { legacyTimeZone: productionZone }
        : {}),
    };
  }
  return productionZone ? { airTime, timeZone: productionZone } : null;
}

/** Keep the canonical provider calendar date separate from the derived broadcast instant. */
export function tvdbBroadcastInstant(
  airDate: string | null | undefined,
  schedule: TvdbBroadcastSchedule | null | undefined,
): string | null {
  if (!schedule || !airDate || !/^\d{4}-\d{2}-\d{2}$/.test(airDate)) return null;
  const date = new Date(airDate + 'T00:00:00.000Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== airDate) return null;
  const [hour, minute] = schedule.airTime.split(':').map(Number);
  const y = date.getUTCFullYear(),
    m = date.getUTCMonth() + 1,
    d = date.getUTCDate();
  const instant = utcFromZoned(schedule.timeZone, y, m, d, hour, minute);
  const matches = (at: Date) => {
    const p = zonedParts(at, schedule.timeZone);
    return p.year === y && p.month === m && p.day === d && p.hour === hour && p.minute === minute;
  };
  // Missing spring-forward times and ambiguous fall-back times are not guessed.
  if (!matches(instant)) return null;
  for (const delta of [-3600000, -1800000, 1800000, 3600000]) {
    if (matches(new Date(instant.getTime() + delta))) return null;
  }
  return instant.toISOString();
}

/** Recognize the old country-derived clock; never shift an arbitrary existing timestamp. */
export function tvdbLegacyBroadcastDate(
  storedAt: Date | null | undefined,
  airTime: string | null | undefined,
  schedule: TvdbBroadcastSchedule | null | undefined,
): string | null {
  if (
    !storedAt ||
    !Number.isFinite(storedAt.getTime()) ||
    !schedule?.legacyTimeZone ||
    airTime !== schedule.airTime
  )
    return null;
  const p = zonedParts(storedAt, schedule.legacyTimeZone);
  const day =
    String(p.year).padStart(4, '0') +
    '-' +
    String(p.month).padStart(2, '0') +
    '-' +
    String(p.day).padStart(2, '0');
  const legacy = tvdbBroadcastInstant(day, { airTime, timeZone: schedule.legacyTimeZone });
  return legacy === storedAt.toISOString() ? day : null;
}
