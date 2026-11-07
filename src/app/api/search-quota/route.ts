import { reserveSearch } from "@/lib/search-quota";
import { clientIp, rateLimit } from "@/lib/rate-limit";

/** Reserve one nearby search before the browser calls Places. */
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host && new URL(origin).host !== host) {
    return Response.json({ error: "허용되지 않은 요청이에요." }, { status: 403 });
  }
  // One visitor shouldn't be able to burn the whole day's budget.
  if (!rateLimit(`search:${clientIp(req)}`, 10, 60_000).ok) {
    return Response.json(
      { enabled: true, allowed: false, reason: "too_fast", error: "검색을 너무 자주 했어요. 1분 뒤에 다시 시도해 주세요." },
      { status: 429 },
    );
  }
  try {
    const r = await reserveSearch();
    return Response.json(r, { status: r.allowed ? 200 : 429, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    // Counter unavailable → don't block the app; Google's own daily quota still applies.
    console.error("[search-quota] reserve failed", e);
    return Response.json({ enabled: false, allowed: true, used: 0, limit: 0 });
  }
}
