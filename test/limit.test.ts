import { expect, test, vi } from 'vitest';
import { clientKey, rateLimiter } from '../src/node/limit';

test('clientKey groups IPv6 by /64 and unwraps IPv4-mapped addresses', () => {
  expect(clientKey('203.0.113.9')).toBe('203.0.113.9');
  expect(clientKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
  expect(clientKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
  expect(clientKey('2001:0db8:0001:0002:bbbb:cccc:dddd:eeee')).toBe('2001:db8:1:2::/64');
  expect(clientKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
  expect(clientKey('[::1]')).toBe('0:0:0:0::/64');
  expect(clientKey('fe80::1%en0')).toBe('fe80:0:0:0::/64');
});

test('rateLimiter: per-key limit, reset per window, bounded without locking out new keys', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-24T00:00:10Z'));
  const l = rateLimiter(2, 60, 3);
  const ok = async (k: string) => (await l.limit({ key: k })).success;
  expect([await ok('a'), await ok('a'), await ok('a')]).toEqual([true, true, false]);
  // Map full: new keys still get through (oldest entries are evicted), so a flood cannot lock others out.
  for (const k of ['b', 'c', 'd', 'e']) expect(await ok(k)).toBe(true);
  vi.setSystemTime(new Date('2026-11-24T00:01:10Z'));
  expect(await ok('a')).toBe(true); // new window
  vi.useRealTimers();
});
