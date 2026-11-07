import { Redis } from "@upstash/redis";

/**
 * App-wide daily cap on Places "nearby search" calls, shared by every visitor.
 *
 * It mirrors the Google Cloud quota (SearchNearbyRequest per day = 30) so the
 * app stops *before* Google starts rejecting, and so we can show the count.
 * Days roll over at midnight US Pacific time, the same moment Google resets
 * per-day quotas (17:00 KST, 16:00 during US daylight saving time).
 */
export const DAILY_SEARCH_LIMIT = Number(process.env.SEARCH_DAILY_LIMIT) || 30;

let redis: Redis | null | undefined;
function getRedis(): Redis | null {
  if (redis !== undefined) return redis;
  const hasEnv =
    (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) &&
    (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN);
  redis = hasEnv ? Redis.fromEnv() : null;
  return redis;
}

function pacificDay(now = new Date()): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(now);
}

const key = () => `lunch:searches:${pacificDay()}`;

export type QuotaState = { enabled: boolean; used: number; limit: number };

/** Atomically reserve one search. `allowed: false` once today's limit is reached. */
export async function reserveSearch(): Promise<QuotaState & { allowed: boolean }> {
  const r = getRedis();
  if (!r) return { enabled: false, allowed: true, used: 0, limit: DAILY_SEARCH_LIMIT };
  const k = key();
  const used = await r.incr(k);
  if (used === 1) await r.expire(k, 60 * 60 * 48);
  const allowed = used <= DAILY_SEARCH_LIMIT;
  return { enabled: true, allowed, used: Math.min(used, DAILY_SEARCH_LIMIT), limit: DAILY_SEARCH_LIMIT };
}
