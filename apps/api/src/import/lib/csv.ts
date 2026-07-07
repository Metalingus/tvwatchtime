import { parse } from 'csv-parse/sync';

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

function detectDelimiter(sample: string): string {
  const firstLine = sample.split(/\r?\n/).find((l) => l.trim().length) ?? '';
  const candidates: Record<string, number> = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  for (const ch of firstLine) {
    if (ch in candidates) candidates[ch]++;
  }
  let best = ',';
  let max = 0;
  for (const [d, c] of Object.entries(candidates)) {
    if (c > max) {
      max = c;
      best = d;
    }
  }
  return best;
}

export function parseCsv(bytes: Buffer): ParsedCsv {
  const text = bytes.toString('utf8');
  const delimiter = detectDelimiter(text.slice(0, 4096));
  const records = parse(text, {
    delimiter,
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    bom: true,
  }) as Record<string, string>[];
  const headers = records.length ? Object.keys(records[0]) : [];
  return { headers, rows: records };
}
