/** Older self-hosted servers reject unknown DTO fields. Presence, not truthiness, is the protocol signal. */
export function supportsCommsUniProtocol(flags?: Record<string, boolean>): boolean {
  return typeof flags?.commsuni_read === 'boolean';
}
