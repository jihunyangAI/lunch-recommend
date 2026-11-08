import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Site-wide password gate (HTTP Basic Auth). Any username is accepted;
// only the password is checked against SITE_PASSWORD.
// - SITE_PASSWORD unset in development: gate is off so local work stays easy.
// - SITE_PASSWORD unset in production: fail closed (503) instead of exposing the site.

function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

function passwordFrom(header: string | null): string | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const bytes = Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    const sep = decoded.indexOf(":");
    return sep === -1 ? null : decoded.slice(sep + 1);
  } catch {
    return null;
  }
}

export function proxy(request: NextRequest) {
  const expected = process.env.SITE_PASSWORD;

  if (!expected) {
    if (process.env.NODE_ENV !== "production") return NextResponse.next();
    return new NextResponse("Site password is not configured.", { status: 503 });
  }

  const given = passwordFrom(request.headers.get("authorization"));
  if (given !== null && safeEqual(given, expected)) return NextResponse.next();

  return new NextResponse("비밀번호가 필요합니다.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="lunch-recommend", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
