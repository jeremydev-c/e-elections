import { randomBytes, randomInt } from "node:crypto";
import type { JWTPayload } from "jose";
import { signToken, verifyToken } from "@/lib/session";
import { LIVENESS, LIVENESS_STEPS, randomSteps, type LivenessStep } from "@/lib/liveness";

/**
 * Server side of the liveness challenge: a signed, short-lived, single-use
 * token naming the voter and the random order of moves they must perform.
 */
type ChallengePayload = JWTPayload & { kind: "liveness"; idNumber: string; steps: LivenessStep[]; nonce: string };

/** Nonces already used (per server instance, like the rate limiter). Entries expire with their token. */
const globalForNonces = globalThis as unknown as { _livenessNonces?: Map<string, number> };
const used = globalForNonces._livenessNonces ?? (globalForNonces._livenessNonces = new Map());

function sweep(now: number) {
  for (const [nonce, until] of used) if (until < now) used.delete(nonce);
}

export async function issueChallenge(idNumber: string) {
  const steps = randomSteps(randomInt);
  const token = await signToken(
    { kind: "liveness", idNumber, steps, nonce: randomBytes(16).toString("base64url") },
    LIVENESS.TOKEN_TTL
  );
  return { token, steps, ttl: LIVENESS.TOKEN_TTL };
}

/**
 * Returns the challenge's moves if the token is genuine, unexpired, issued for
 * this voter and not used before; marks it used. Otherwise null.
 */
export async function redeemChallenge(token: unknown, idNumber: string): Promise<LivenessStep[] | null> {
  if (typeof token !== "string") return null;
  const p = await verifyToken<ChallengePayload>(token);
  if (!p || p.kind !== "liveness" || p.idNumber !== idNumber || typeof p.nonce !== "string") return null;
  if (!Array.isArray(p.steps) || p.steps.length !== LIVENESS_STEPS.length) return null;

  const now = Date.now();
  sweep(now);
  if (used.has(p.nonce)) return null;
  used.set(p.nonce, (p.exp ?? now / 1000 + LIVENESS.TOKEN_TTL) * 1000);
  return p.steps;
}
