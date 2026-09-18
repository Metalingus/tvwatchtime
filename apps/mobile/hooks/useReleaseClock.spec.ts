import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { QueryClient } from '@tanstack/react-query';
import { useReleaseClock } from './useReleaseClock';

jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useEffect: jest.fn(),
}));
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { addEventListener: jest.fn() },
}));

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const clients: QueryClient[] = [];
let removeNative: jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-18T03:50:00Z'));
  jest.clearAllMocks();
  removeNative = jest.fn();
  jest.mocked(AppState.addEventListener).mockReturnValue({ remove: removeNative });
});

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  jest.clearAllTimers();
  jest.useRealTimers();
});

function mount(os: 'android' | 'ios' | 'web', host: unknown) {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: host });
  const client = new QueryClient();
  clients.push(client);
  client.setQueryData(['watchNext'], { refreshAt: '2026-09-18T04:00:00Z' });
  useReleaseClock(client);
  const setup = jest.mocked(useEffect).mock.calls.at(-1)![0];
  return { client, setup };
}

it.each(['android', 'ios'] as const)(
  'starts and cleans up on %s when window is the native global without DOM event methods',
  (os) => {
    const { setup } = mount(os, globalThis);
    let cleanup: ReturnType<typeof setup>;
    expect(() => {
      cleanup = setup();
    }).not.toThrow();
    expect(AppState.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(() => cleanup?.()).not.toThrow();
    expect(removeNative).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  },
);

it('still refreshes Android data when returning after a broadcast boundary', () => {
  const { client, setup } = mount('android', globalThis);
  const invalidate = jest.spyOn(client, 'invalidateQueries');
  const cleanup = setup();
  const resume = jest.mocked(AppState.addEventListener).mock.calls[0][1];
  jest.setSystemTime(new Date('2026-09-18T04:00:01Z'));
  resume('active');
  expect(invalidate).toHaveBeenCalledTimes(1);
  cleanup?.();
});

it('registers and removes the browser focus listener on web', () => {
  const host = { addEventListener: jest.fn(), removeEventListener: jest.fn() };
  const { setup } = mount('web', host);
  const cleanup = setup();
  expect(host.addEventListener).toHaveBeenCalledWith('focus', expect.any(Function));
  cleanup?.();
  expect(host.removeEventListener).toHaveBeenCalledWith(
    'focus',
    host.addEventListener.mock.calls[0][1],
  );
});

it('tolerates a web/headless environment without DOM listener methods', () => {
  const { setup } = mount('web', {});
  const cleanup = setup();
  expect(() => cleanup?.()).not.toThrow();
});
