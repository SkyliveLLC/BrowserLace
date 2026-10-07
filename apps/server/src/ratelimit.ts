/**
 * In-memory token buckets. The server is a single process, so no shared store is needed.
 * Each key (an IP or a device) holds up to `burst` requests and regains `perMinute` a minute.
 */
export type RateLimit = { burst: number; perMinute: number };

export function rateLimiter({ burst, perMinute }: RateLimit) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  /** Takes one request from `key`'s bucket. Returns false when it's empty. */
  return (key: string, now: number): boolean => {
    const bucket = buckets.get(key) ?? { tokens: burst, at: now };
    bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.at) / 60_000) * perMinute);
    bucket.at = now;
    if (buckets.size > 50_000) {
      // Forget keys that have refilled completely; they'd start full anyway.
      for (const [k, b] of buckets) if (b.tokens + ((now - b.at) / 60_000) * perMinute >= burst) buckets.delete(k);
    }
    buckets.set(key, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };
}
