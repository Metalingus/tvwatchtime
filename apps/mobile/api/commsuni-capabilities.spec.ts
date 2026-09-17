import { supportsCommsUniProtocol } from './commsuni-capabilities';

describe('comment protocol compatibility', () => {
  it('keeps requests compatible with older self-hosted backends', () => {
    expect(supportsCommsUniProtocol(undefined)).toBe(false);
    expect(supportsCommsUniProtocol({ comments_enabled: true })).toBe(false);
  });
  it('accepts the new protocol even when provider reads are disabled', () => {
    expect(supportsCommsUniProtocol({ commsuni_read: false })).toBe(true);
  });
  it('accepts the enabled read-only integration', () => {
    expect(supportsCommsUniProtocol({ commsuni_read: true, commsuni_write: false })).toBe(true);
  });
});
