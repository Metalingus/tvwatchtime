// Parser for TV Time's Go `%v`-formatted list `objects` column. Format examples:
//   series: [map[created_at:1.56338973e+09 id:73739 type:series] map[...]]
//   movies: [map[created_at:1.614733632e+09 type:movie uuid:6254be80-...]]
// It is NOT JSON. This parser is depth-aware (bracketed values like posters:[url url]
// don't terminate a map early) and never throws — a malformed object becomes an error,
// not a crash. See __tests__/list-objects.spec.ts.

export interface ParsedListObject {
  type: string; // 'series' | 'movie' | other
  id: number | null;
  uuid: string | null;
  createdAt: Date | null;
}

export interface ListObjectParseError {
  /** 0-based index of the object within the input. */
  index: number;
  reason: string;
}

export interface ParseListObjectsResult {
  objects: ParsedListObject[];
  errors: ListObjectParseError[];
}

/** Parse the inside of one `map[ ... ]`, depth-aware. `start` points just after `map[`. */
function parseMapAt(s: string, start: number): { fields: Record<string, string>; next: number } {
  const fields: Record<string, string> = {};
  let i = start;
  const n = s.length;
  while (i < n) {
    while (i < n && s[i] === ' ') i++; // skip spaces between pairs
    if (i >= n) break;
    if (s[i] === ']') return { fields, next: i + 1 }; // end of this map

    const keyStart = i;
    while (i < n && s[i] !== ':' && s[i] !== ' ' && s[i] !== ']') i++;
    if (i >= n || s[i] !== ':') {
      // token without a colon — skip to the next space/`]`
      while (i < n && s[i] !== ' ' && s[i] !== ']') i++;
      continue;
    }
    const key = s.slice(keyStart, i);
    i++; // consume ':'

    if (s[i] === '[') {
      // bracketed group (e.g. posters:[url url]) — consume until its matching `]`
      let depth = 1;
      i++; // past '['
      const valStart = i;
      while (i < n && depth > 0) {
        if (s[i] === '[') depth++;
        else if (s[i] === ']') {
          depth--;
          if (depth === 0) break;
        }
        i++;
      }
      fields[key] = s.slice(valStart, i).trim();
      if (i < n && s[i] === ']') i++; // consume closing `]`
    } else {
      // scalar value: until the next space or `]`
      const valStart = i;
      while (i < n && s[i] !== ' ' && s[i] !== ']') i++;
      fields[key] = s.slice(valStart, i);
    }
  }
  return { fields, next: i };
}

function toEpochDate(raw: string | undefined): Date | null {
  if (raw == null || raw === '' || raw === '<nil>') return null;
  const num = Number(raw);
  if (Number.isFinite(num)) {
    if (num <= 0) return null; // reject bogus negatives (e.g. -6.21e+10)
    const ms = num > 1e12 ? num : num * 1000; // epoch-ms vs epoch-seconds (incl. scientific)
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(raw.replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Parse a TV Time `objects` cell into structured list objects.
 * Never throws: malformed objects are reported in `errors` and skipped.
 */
export function parseListObjects(input: string | null | undefined): ParseListObjectsResult {
  const objects: ParsedListObject[] = [];
  const errors: ListObjectParseError[] = [];
  try {
    const trimmed = (input ?? '').trim();
    if (!trimmed || trimmed === '[]') return { objects, errors };

    // Strip a single outer `[ ... ]`.
    let s = trimmed;
    if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);

    let i = 0;
    const n = s.length;
    let index = 0;
    while (i < n) {
      const at = s.indexOf('map[', i);
      if (at === -1) break;
      const { fields, next } = parseMapAt(s, at + 4);
      i = next;
      if (Object.keys(fields).length === 0) {
        errors.push({ index, reason: 'empty or malformed map' });
      } else {
        objects.push({
          type: fields.type ?? '',
          id: fields.id != null && fields.id !== '<nil>' ? (Number.isFinite(Number(fields.id)) ? Number(fields.id) : null) : null,
          uuid: fields.uuid && fields.uuid !== '<nil>' ? fields.uuid : null,
          createdAt: toEpochDate(fields.created_at),
        });
      }
      index++;
    }
  } catch {
    errors.push({ index: objects.length, reason: 'unexpected parser failure' });
  }
  return { objects, errors };
}
