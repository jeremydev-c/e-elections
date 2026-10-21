import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import type { NextRequest } from "next/server";

/**
 * Signed, short-lived tokens stored in httpOnly cookies.
 * Used for: admin sessions, WebAuthn challenges, and (Phase 3) ballot sessions.
 */

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error("SESSION_SECRET is missing or shorter than 32 characters (.env.local).");
  }
  return new TextEncoder().encode(s);
}

export async function signToken(payload: JWTPayload, ttlSeconds: number): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret());
}

export async function verifyToken<T extends JWTPayload>(token?: string): Promise<T | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return payload as T;
  } catch {
    return null;
  }
}

export function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

// ---- Admin session ---------------------------------------------------------
export const ADMIN_COOKIE = "ee_admin";
export const ADMIN_TTL = 8 * 60 * 60; // 8 hours

type AdminPayload = JWTPayload & { role: "admin"; username: string };

export async function getAdmin(req: NextRequest): Promise<AdminPayload | null> {
  const p = await verifyToken<AdminPayload>(req.cookies.get(ADMIN_COOKIE)?.value);
  return p?.role === "admin" ? p : null;
}

// ---- Voter Ballot session --------------------------------------------------
export const BALLOT_COOKIE = "ee_ballot";
export const BALLOT_TTL = 30 * 60; // 30 minutes to complete voting

export type BallotSessionPayload = JWTPayload & {
  role: "voter";
  voterId: string;
  fullName: string;
  countyCode: string;
  constituencyCode: string;
  wardCode: string;
};

export async function getVoterSession(req: NextRequest): Promise<BallotSessionPayload | null> {
  const p = await verifyToken<BallotSessionPayload>(req.cookies.get(BALLOT_COOKIE)?.value);
  return p?.role === "voter" ? p : null;
}
