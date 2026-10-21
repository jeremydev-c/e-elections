import type { NextRequest } from "next/server";

/**
 * WebAuthn relying-party info, derived from the request so it works on
 * localhost, on the LAN and behind an HTTPS tunnel (ngrok / Cloudflare).
 */
export function getRelyingParty(req: NextRequest) {
  // In production set APP_ORIGIN (e.g. https://e-elections.example.ke) so the
  // fingerprint ceremony never trusts a client-supplied Host header.
  const pinned = process.env.APP_ORIGIN;
  if (pinned) {
    const url = new URL(pinned);
    return { rpName: "E-ELECTIONS Kenya", rpID: url.hostname, origin: url.origin };
  }
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost";
  const proto =
    req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return {
    rpName: "E-ELECTIONS Kenya",
    rpID: host.split(":")[0],
    origin: `${proto}://${host}`,
  };
}

export const WA_REG_COOKIE = "ee_wa_reg";
export const WA_AUTH_COOKIE = "ee_wa_auth";
