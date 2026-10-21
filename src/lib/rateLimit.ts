import type { NextRequest } from "next/server";

/**
 * Small in-memory failure limiter (per server instance), used to stop
 * brute-forcing of PINs, face templates and ID lookups.
 */
type Entry = { count: number; until: number; first: number };

const globalForLimits = globalThis as unknown as { _limits?: Map<string, Entry> };
const store = globalForLimits._limits ?? (globalForLimits._limits = new Map());

const WINDOW_MS = 10 * 60_000;

export function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
}

/** Seconds until `key` may try again, or 0 if it is not locked. */
export function lockedFor(key: string): number {
  const e = store.get(key);
  if (!e) return 0;
  const left = e.until - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/** Records a failure. After `max` failures in 10 minutes, locks `key` for `lockMs`. */
export function recordFailure(key: string, max = 5, lockMs = 5 * 60_000): void {
  const now = Date.now();
  const e = store.get(key);
  const fresh = !e || now - e.first > WINDOW_MS;
  const count = fresh ? 1 : e.count + 1;
  store.set(key, { count, first: fresh ? now : e.first, until: count >= max ? now + lockMs : 0 });
}

export function clearFailures(key: string): void {
  store.delete(key);
}
