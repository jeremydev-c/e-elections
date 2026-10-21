import { connectDB } from "@/lib/mongodb";
import { verifyChain, type BallotForHash } from "@/lib/hashChain";
import { VoteLedger, ChainHead } from "@/models/VoteLedger";
import { Voter } from "@/models/Voter";

export type LedgerBlock = BallotForHash & {
  selections: Record<string, string>;
  currentHash: string;
  seal?: string;
};

type RawBlock = {
  seq: number;
  receiptCode: string;
  selections?: Map<string, string> | Record<string, string> | null;
  /** Field name used by ballots cast before the `selections` rename. */
  choices?: Map<string, string> | Record<string, string> | null;
  county?: string | null;
  timestamp: Date | string;
  previousHash: string;
  currentHash: string;
  seal?: string | null;
};

function toRecord(m: RawBlock["selections"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!m) return out;
  const entries = m instanceof Map ? m.entries() : Object.entries(m);
  for (const [k, v] of entries) out[String(k)] = String(v);
  return out;
}

/** Converts a stored ledger document into the exact shape that was hashed. */
export function normalizeBlock(raw: unknown): LedgerBlock {
  const b = raw as RawBlock;
  return {
    seq: b.seq,
    receiptCode: b.receiptCode,
    selections: toRecord(b.selections ?? b.choices),
    county: b.county ?? undefined,
    timestamp: b.timestamp instanceof Date ? b.timestamp : new Date(b.timestamp),
    previousHash: b.previousHash,
    currentHash: b.currentHash,
    seal: b.seal ?? undefined,
  };
}

export async function loadLedger(): Promise<LedgerBlock[]> {
  await connectDB();
  const docs = await VoteLedger.find().sort({ seq: 1 }).lean();
  return docs.map(normalizeBlock);
}

export async function loadChainHead() {
  await connectDB();
  return ChainHead.findById("main").lean();
}

/**
 * Full audit: recomputes every SHA-256 hash, checks every HMAC seal and link,
 * the signed chain head, and that ballots == voters marked as voted.
 */
export async function auditLedger() {
  const run = async () => {
    const [blocks, head, votersMarkedVoted] = await Promise.all([
      loadLedger(),
      loadChainHead(),
      Voter.countDocuments({ hasVoted: true }),
    ]);
    return { blocks, head, votersMarkedVoted, audit: verifyChain(blocks, head, votersMarkedVoted) };
  };
  const first = await run();
  if (first.audit.intact) return first;
  // A vote committing between the parallel reads above can look like a
  // mismatch for a moment. Real tampering is still there on a second look.
  await new Promise((r) => setTimeout(r, 300));
  return run();
}

/** Votes per candidate id, counted from the ledger (the source of truth). */
export function tallyFromLedger(blocks: LedgerBlock[]): Map<string, number> {
  const tally = new Map<string, number>();
  for (const b of blocks) {
    for (const id of Object.values(b.selections)) tally.set(id, (tally.get(id) ?? 0) + 1);
  }
  return tally;
}
