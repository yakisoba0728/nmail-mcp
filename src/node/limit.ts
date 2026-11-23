/**
 * Fixed-window rate limiter with the shape of the Workers rate-limit binding. Memory is bounded per window:
 * - keys under the limit live in `counting`; when it is full the oldest is evicted (refusing new keys instead would
 *   let a flood of addresses lock everyone out);
 * - keys over the limit move to `blocked`, which eviction in `counting` never touches, so flooding cannot reset a
 *   block. `blocked` has the same cap; filling it takes `limit + 1` requests per key.
 */
export function rateLimiter(limit: number, periodSec: number, maxKeys = 50_000) {
  const counting = new Map<string, number>();
  const blocked = new Set<string>();
  let current = 0;
  return {
    async limit({ key }: { key: string }) {
      const window = Math.floor(Date.now() / 1000 / periodSec);
      if (window !== current) {
        counting.clear();
        blocked.clear();
        current = window;
      }
      if (blocked.has(key)) return { success: false };
      const count = (counting.get(key) ?? 0) + 1;
      if (count > limit) {
        counting.delete(key);
        if (blocked.size >= maxKeys) blocked.delete(blocked.values().next().value!);
        blocked.add(key);
        return { success: false };
      }
      if (!counting.has(key) && counting.size >= maxKeys) counting.delete(counting.keys().next().value!);
      counting.set(key, count);
      return { success: true };
    },
  };
}

/**
 * Rate-limit key for a client address: IPv4 as is, IPv6 by its /64 network (one host can use every address in it).
 * IPv4-mapped IPv6 (::ffff:a.b.c.d) is treated as IPv4.
 */
export function clientKey(ip: string): string {
  const addr = ip.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) return mapped[1];
  if (!addr.includes(':')) return addr;
  const [head, tail = ''] = addr.split('::');
  const left = head ? head.split(':') : [];
  const right = addr.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = addr.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
