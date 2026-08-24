/** Curated ISO 3166-1 country list shared by Explore and personal-library filters. */
export const FILTER_COUNTRY_CODES = [
  'US',
  'GB',
  'FR',
  'DE',
  'ES',
  'IT',
  'JP',
  'KR',
  'CN',
  'IN',
  'TR',
  'BR',
  'MX',
  'CA',
  'AU',
] as const;

/**
 * ISO 3166-1 alpha-2 code → flag emoji (regional indicator symbols).
 * Renders as a real flag on iOS/macOS/web; Android shows the two letters instead,
 * which degrades gracefully to the plain code. Non-alpha-2 input is returned as-is.
 */
export function countryFlag(code: string): string {
  const iso = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(iso)) return code;
  return String.fromCodePoint(...[...iso].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
