import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { ledgerKey } from "@/lib/secrets";

/** Hash that the very first ballot links to. */
export const GENESIS_HASH = createHash("sha256").update("E-ELECTIONS-2027-GENESIS").digest("hex");

export type BallotForHash = {
  seq: number;
  receiptCode: string;
  selections: Record<string, string> | Map<string, string>;
  /** Absent only on ballots cast before the county field existed. */
  county?: string;
  timestamp: Date;
  previousHash: string;
};

/**
 * Deterministic serialisation. Selection keys are sorted so the same ballot
 * always produces the same string, however it was stored or read back.
 */
function canonical(b: BallotForHash): string {
  const entries =
    b.selections instanceof Map ? [...b.selections.entries()] : Object.entries(b.selections);
  const selections = entries
    .sort(([a], [z]) => a.localeCompare(z))
    .map(([k, v]) => `${k}=${v}`)
    .join(";");
  const parts: (string | number)[] = [
    b.seq,
    b.receiptCode,
    selections,
    b.timestamp.toISOString(),
    b.previousHash,
  ];
  if (b.county !== undefined) parts.push(b.county);
  return parts.join("|");
}

/** SHA-256 of the ballot contents + the previous ballot's hash (publicly checkable). */
export function computeBallotHash(b: BallotForHash): string {
  return createHash("sha256").update(canonical(b)).digest("hex");
}

/**
 * Server seal: HMAC-SHA256 of the ballot hash with the secret ledger key.
 * Anyone can recompute a SHA-256 hash, but only the server can produce a
 * valid seal, so a database intruder cannot rewrite the chain unnoticed.
 */
export function sealBallot(currentHash: string): string {
  return createHmac("sha256", ledgerKey()).update(`ballot|${currentHash}`).digest("hex");
}

/** Seal for the chain head, so the newest ballots can't be silently rolled back. */
export function sealHead(seq: number, lastHash: string): string {
  return createHmac("sha256", ledgerKey()).update(`head|${seq}|${lastHash}`).digest("hex");
}

export function sealMatches(expected: string, actual: string | null | undefined): boolean {
  if (!actual || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

export type ChainIssue = {
  seq: number;
  receiptCode: string;
  problem:
    | "HASH_MISMATCH"
    | "BROKEN_LINK"
    | "SEQUENCE_GAP"
    | "BAD_SEAL"
    | "HEAD_MISMATCH"
    | "BAD_HEAD_SEAL"
    | "TURNOUT_MISMATCH";
};

export type ChainAudit = {
  intact: boolean;
  checked: number;
  tamperedVotes: number;
  issues: ChainIssue[];
};

export type SealedBallot = BallotForHash & { currentHash: string; seal?: string | null };
export type SealedHead = { seq: number; lastHash: string; seal?: string | null };

/**
 * Walks the ledger in order and reports every record that has been altered
 * (hash mismatch), re-hashed without the server key (bad seal), whose link
 * to the previous record is broken, or that is missing from the sequence.
 * With the signed chain `head` it also catches deletion of the newest
 * ballots, and with `votersMarkedVoted` it catches ballots that were
 * deleted or stuffed in without a matching voter.
 */
export function verifyChain(
  ballots: SealedBallot[],
  head?: SealedHead | null,
  votersMarkedVoted?: number
): ChainAudit {
  const issues: ChainIssue[] = [];
  let expectedPrev = GENESIS_HASH;
  let expectedSeq = 1;

  for (const b of ballots) {
    if (b.seq !== expectedSeq) {
      issues.push({ seq: b.seq, receiptCode: b.receiptCode, problem: "SEQUENCE_GAP" });
    }
    if (b.previousHash !== expectedPrev) {
      issues.push({ seq: b.seq, receiptCode: b.receiptCode, problem: "BROKEN_LINK" });
    }
    if (computeBallotHash(b) !== b.currentHash) {
      issues.push({ seq: b.seq, receiptCode: b.receiptCode, problem: "HASH_MISMATCH" });
    }
    if (!sealMatches(sealBallot(b.currentHash), b.seal)) {
      issues.push({ seq: b.seq, receiptCode: b.receiptCode, problem: "BAD_SEAL" });
    }
    expectedPrev = b.currentHash;
    expectedSeq = b.seq + 1;
  }

  if (head) {
    if (head.seq !== expectedSeq - 1 || (head.seq > 0 && head.lastHash !== expectedPrev)) {
      issues.push({ seq: head.seq, receiptCode: "(chain head)", problem: "HEAD_MISMATCH" });
    }
    // An empty genesis head needs no seal; any head that points at ballots does.
    if (head.seq > 0 && !sealMatches(sealHead(head.seq, head.lastHash), head.seal)) {
      issues.push({ seq: head.seq, receiptCode: "(chain head)", problem: "BAD_HEAD_SEAL" });
    }
  }

  if (votersMarkedVoted !== undefined && votersMarkedVoted !== ballots.length) {
    issues.push({ seq: 0, receiptCode: "(voter register)", problem: "TURNOUT_MISMATCH" });
  }

  return {
    intact: issues.length === 0,
    checked: ballots.length,
    tamperedVotes: new Set(issues.filter((i) => i.seq > 0 && i.receiptCode.startsWith("KE-")).map((i) => i.seq)).size,
    issues,
  };
}

// No 0/O/1/I to avoid confusion when voters type their receipt.
const RECEIPT_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** e.g. KE-2027-8F92-K7QX (40 bits of randomness, cryptographically secure). */
export function generateReceiptCode(): string {
  const pick = (n: number) =>
    Array.from({ length: n }, () => RECEIPT_ALPHABET[randomInt(RECEIPT_ALPHABET.length)]).join("");
  return `KE-2027-${pick(4)}-${pick(4)}`;
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
