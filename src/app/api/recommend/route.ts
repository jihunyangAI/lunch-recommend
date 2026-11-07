import { GoogleGenAI, ThinkingLevel, type ThinkingConfig } from "@google/genai";
import type { AiResult, RestaurantSummary } from "@/lib/types";
import { clientIp, rateLimit } from "@/lib/rate-limit";

const PER_MINUTE = 6;
const PER_DAY = 100;

// Tried in order; a model that is unavailable (404) falls through to the next.
const MODELS = Array.from(
  new Set([
    process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash-lite",
  ]),
);

// Picking 3 places from a short list doesn't need deep reasoning; minimal
// thinking cuts latency and, more importantly, the occasional multi-second spikes.
// Gemini 3.x takes a thinking level; 2.5 takes a token budget (0 = off).
function thinkingFor(model: string): ThinkingConfig {
  return model.startsWith("gemini-2.") ? { thinkingBudget: 0 } : { thinkingLevel: ThinkingLevel.MINIMAL };
}

const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "한 문장 요약 (한국어)" },
    picks: {
      type: "array",
      description: "추천 식당 최대 3곳, 가장 추천하는 순서",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "입력 목록의 id 그대로" },
          reason: { type: "string", description: "추천 이유 1~2문장 (한국어)" },
        },
        required: ["id", "reason"],
      },
    },
  },
  required: ["summary", "picks"],
};

export async function POST(req: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "GEMINI_API_KEY가 설정되지 않았어요. .env.local에 추가한 뒤 서버를 다시 시작해 주세요." },
      { status: 503 },
    );
  }

  // Only our own page may call this (blocks other sites embedding it; not a substitute for auth).
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host && new URL(origin).host !== host) {
    return Response.json({ error: "허용되지 않은 요청이에요." }, { status: 403 });
  }

  const ip = clientIp(req);
  for (const [limit, windowMs, label] of [
    [PER_MINUTE, 60_000, "잠시 후"],
    [PER_DAY, 86_400_000, "내일"],
  ] as const) {
    const r = rateLimit(`${ip}:${windowMs}`, limit, windowMs);
    if (!r.ok) {
      return Response.json(
        { error: `AI 추천 요청이 너무 많아요. ${label} 다시 시도해 주세요.` },
        { status: 429, headers: { "Retry-After": String(r.retryAfter) } },
      );
    }
  }

  const raw = await req.text();
  if (raw.length > 20_000) {
    return Response.json({ error: "요청이 너무 커요." }, { status: 413 });
  }
  let body: { mood?: unknown; restaurants?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "잘못된 요청이에요." }, { status: 400 });
  }
  const mood = typeof body.mood === "string" ? body.mood.slice(0, 100).trim() : "";
  const restaurants = (Array.isArray(body.restaurants) ? body.restaurants : []).slice(0, 20) as RestaurantSummary[];
  if (restaurants.length === 0) {
    return Response.json({ error: "추천할 식당 목록이 비어 있어요." }, { status: 400 });
  }

  const now = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());

  const prompt = [
    "너는 사용자의 '오늘 뭐 먹지?' 고민을 해결해 주는 맛집 추천 도우미야.",
    `현재 시각(한국): ${now}`,
    mood ? `사용자의 요청/기분: "${mood}"` : "사용자가 특별한 요청을 남기지 않았어. 거리, 평점, 리뷰 수, 가격대를 균형 있게 고려해.",
    "아래 주변 식당 목록(JSON)에서만 골라 최대 3곳을 추천해. 목록에 없는 식당은 절대 만들지 마.",
    "distance는 미터, priceLevel은 Google 가격대(INEXPENSIVE~VERY_EXPENSIVE, null은 정보 없음)야.",
    JSON.stringify(restaurants),
  ].join("\n");

  const ai = new GoogleGenAI({ apiKey });
  const validIds = new Set(restaurants.map((r) => r.id));

  for (const model of MODELS) {
    try {
      const res = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: SCHEMA,
          temperature: 0.8,
          thinkingConfig: thinkingFor(model),
          maxOutputTokens: 1024,
        },
      });
      const parsed = JSON.parse(res.text ?? "{}") as Omit<AiResult, "model">;
      const picks = (parsed.picks ?? []).filter((p) => validIds.has(p.id)).slice(0, 3);
      return Response.json({ model, summary: parsed.summary ?? "", picks } satisfies AiResult);
    } catch (e) {
      const status = (e as { status?: number }).status;
      console.error(`[recommend] ${model} failed (status ${status ?? "?"})`);
      // Model missing (404), overloaded (503/429) or flaky (500) → try the next model.
      if (status === 404 || status === 429 || status === 500 || status === 503) continue;
      return Response.json({ error: "AI 추천 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요." }, { status: 502 });
    }
  }
  return Response.json({ error: "지금 AI가 혼잡해요. 잠시 후 다시 시도해 주세요." }, { status: 503 });
}
