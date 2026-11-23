/**
 * Fixed-window rate limiter with the shape of the Workers rate-limit binding.
 * Memory is bounded: one window at a time, at most `maxKeys` entries; when full the oldest entry is evicted
 * (refusing new keys instead would let a flood of addresses lock everyone out).
 */
export function rateLimiter(limit: number, periodSec: number, maxKeys = 50_000) {
  const hits = new Map<string, number>();
  let current = 0;
  return {
    async limit({ key }: { key: string }) {
      const window = Math.floor(Date.now() / 1000 / periodSec);
      if (window !== current) {
        hits.clear();
        current = window;
      }
      const count = (hits.get(key) ?? 0) + 1;
      if (!hits.has(key) && hits.size >= maxKeys) hits.delete(hits.keys().next().value!);
      hits.set(key, count);
      return { success: count <= limit };
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
