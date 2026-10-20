const mockRandomUUID = jest.fn();
const mockGetRandomValues = jest.fn();

jest.mock('expo-crypto', () => ({
  randomUUID: () => mockRandomUUID(),
  getRandomValues: (bytes: Uint8Array) => mockGetRandomValues(bytes),
}));

import { randomUUID, uuidFromBytes } from './uuid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  mockRandomUUID.mockReset();
  mockGetRandomValues.mockReset();
});

it('uses expo-crypto when it is available', () => {
  mockRandomUUID.mockReturnValue('11111111-2222-4333-8444-555555555555');
  expect(randomUUID()).toBe('11111111-2222-4333-8444-555555555555');
  expect(mockGetRandomValues).not.toHaveBeenCalled();
});

it('builds a v4 UUID from getRandomValues outside a secure context', () => {
  mockRandomUUID.mockImplementation(() => {
    throw new TypeError('crypto.randomUUID is not a function');
  });
  mockGetRandomValues.mockImplementation((bytes: Uint8Array) => bytes.fill(0xff));
  expect(randomUUID()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
});

it('still returns a v4 UUID when no crypto source works', () => {
  mockRandomUUID.mockImplementation(() => {
    throw new TypeError('crypto.randomUUID is not a function');
  });
  mockGetRandomValues.mockImplementation(() => {
    throw new Error('unavailable');
  });
  const ids = new Set(Array.from({ length: 20 }, () => randomUUID()));
  for (const id of ids) expect(id).toMatch(V4);
  expect(ids.size).toBe(20);
});

it('sets the version and variant bits', () => {
  expect(uuidFromBytes(new Uint8Array(16))).toBe('00000000-0000-4000-8000-000000000000');
});
