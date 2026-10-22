import { connectDB } from "@/lib/mongodb";
import { LEGACY_CHAIN, verifyLedger, type BallotForHash, type ChainHeadRecord } from "@/lib/hashChain";
import { VoteLedger, ChainHead } from "@/models/VoteLedger";
import { Voter } from "@/models/Voter";

export type LedgerBlock = BallotForHash & {
  selections: Record<string, string>;
  currentHash: string;
  seal?: string;
};

type RawBlock = {
  chain?: string | null;
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
    ...(b.chain ? { chain: b.chain } : {}),
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
  const docs = await VoteLedger.find().sort({ chain: 1, seq: 1 }).lean();
  return docs.map(normalizeBlock);
}

/** Every chain's head (one per county that has voted, plus "main" from before county chains). */
export async function loadChainHeads(): Promise<ChainHeadRecord[]> {
  await connectDB();
  const heads = await ChainHead.find().lean();
  return heads.map((h) => ({ chain: String(h._id ?? LEGACY_CHAIN), seq: h.seq ?? 0, lastHash: h.lastHash, seal: h.seal ?? undefined }));
}

/**
 * Full audit: recomputes every SHA-256 hash, checks every HMAC seal and link and
 * the signed head of every county chain, that ballots == voters marked as voted,
 * and computes the Merkle root of all the chain heads (one fingerprint of the election).
 */
export async function auditLedger() {
  const run = async () => {
    const [blocks, heads, votersMarkedVoted] = await Promise.all([
      loadLedger(),
      loadChainHeads(),
      Voter.countDocuments({ hasVoted: true }),
    ]);
    return { blocks, heads, votersMarkedVoted, audit: verifyLedger(blocks, heads, votersMarkedVoted) };
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
