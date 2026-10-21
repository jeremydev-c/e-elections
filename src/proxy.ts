import { NextResponse, type NextRequest } from "next/server";

/** Largest JSON body any API accepts (a face reading plus a photo is ~200 KB). */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Runs before every API request:
 *  - CSRF defence: state-changing requests must come from this site's own
 *    pages (Origin / Sec-Fetch-Site), on top of SameSite=Strict cookies.
 *  - Rejects oversized bodies before any route parses them.
 */
export function proxy(req: NextRequest) {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return NextResponse.next();

  const size = Number(req.headers.get("content-length") ?? 0);
  if (size > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Request too large." }, { status: 413 });
  }

  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return NextResponse.json({ error: "Cross-site request blocked." }, { status: 403 });
  }

  const origin = req.headers.get("origin");
  if (origin) {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      // malformed Origin header falls through to the mismatch below
    }
    if (!host || originHost !== host) {
      return NextResponse.json({ error: "Cross-site request blocked." }, { status: 403 });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
