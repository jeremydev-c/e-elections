import type { NextRequest } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { clientIp } from "@/lib/rateLimit";
import { AuditLog } from "@/models/AuditLog";

export type AuditEvent =
  | "ADMIN_LOGIN_FAILED"
  | "ADMIN_LOGIN"
  | "ADMIN_LOCKED_OUT"
  | "VOTER_REGISTERED"
  | "DUPLICATE_FACE_BLOCKED"
  | "DOUBLE_VOTE_BLOCKED"
  | "FACE_MATCH_FAILED"
  | "FACE_LOCKED_OUT"
  | "FINGERPRINT_FAILED"
  | "INVALID_BALLOT_REJECTED"
  | "LEDGER_TAMPER_DETECTED"
  | "DATABASE_SEEDED"
  | "ELECTION_RESET";

type Severity = "info" | "warning" | "critical";

/** Writes a security event. Never throws: logging must not break voting. */
export async function audit(
  event: AuditEvent,
  {
    req,
    severity = "info",
    actor,
    idNumber,
    detail,
  }: { req?: NextRequest; severity?: Severity; actor?: string; idNumber?: string; detail?: string } = {}
): Promise<void> {
  try {
    await connectDB();
    await AuditLog.create({
      event,
      severity,
      actor,
      idNumber,
      ip: req ? clientIp(req) : undefined,
      detail: detail?.slice(0, 300),
    });
  } catch (err) {
    console.error("audit log write failed:", (err as Error).message);
  }
}

const tamperState = globalThis as unknown as { _lastTamperKey?: string };

/**
 * Logs ledger tampering once per distinct finding (the results page polls
 * every 3 seconds, so the same alarm must not flood the log).
 */
export async function logTamperOnce(findings: string[], req?: NextRequest): Promise<void> {
  const key = findings.join(", ");
  if (key === (tamperState._lastTamperKey ?? "")) return;
  tamperState._lastTamperKey = key;
  if (key) await audit("LEDGER_TAMPER_DETECTED", { req, severity: "critical", actor: "system", detail: key });
}
