import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { ledgerKey } from "@/lib/secrets";

/** Hash that the very first ballot links to. */
export const GENESIS_HASH = createHash("sha256").update("E-ELECTIONS-2027-GENESIS").digest("hex");

/**
 * Every county has its own chain (its id is the county code), so voters in different
 * counties never wait for each other. Ballots cast before that live on the "main" chain.
 */
export const LEGACY_CHAIN = "main";

/** Each chain starts from its own genesis, so a ballot can't be moved to another county's chain. */
export function chainGenesis(chain: string = LEGACY_CHAIN): string {
  return chain === LEGACY_CHAIN ? GENESIS_HASH : createHash("sha256").update(`E-ELECTIONS-2027-GENESIS|${chain}`).digest("hex");
}

export type BallotForHash = {
  /** County chain id; absent on ballots of the original single chain. */
  chain?: string;
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
  if (b.chain !== undefined && b.chain !== LEGACY_CHAIN) parts.push(`chain=${b.chain}`);
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

/** Seal for a chain head, so the newest ballots can't be silently rolled back. */
export function sealHead(seq: number, lastHash: string, chain: string = LEGACY_CHAIN): string {
  const what = chain === LEGACY_CHAIN ? `head|${seq}|${lastHash}` : `head|${chain}|${seq}|${lastHash}`;
  return createHmac("sha256", ledgerKey()).update(what).digest("hex");
}

export function sealMatches(expected: string, actual: string | null | undefined): boolean {
  if (!actual || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

export type ChainIssue = {
  chain?: string;
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
export type ChainHeadRecord = SealedHead & { chain: string };

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
  votersMarkedVoted?: number,
  chain: string = LEGACY_CHAIN
): ChainAudit {
  const issues: ChainIssue[] = [];
  const tag = chain === LEGACY_CHAIN ? {} : { chain };
  let expectedPrev = chainGenesis(chain);
  let expectedSeq = 1;

  for (const b of ballots) {
    if (b.seq !== expectedSeq) {
      issues.push({ ...tag, seq: b.seq, receiptCode: b.receiptCode, problem: "SEQUENCE_GAP" });
    }
    if (b.previousHash !== expectedPrev) {
      issues.push({ ...tag, seq: b.seq, receiptCode: b.receiptCode, problem: "BROKEN_LINK" });
    }
    if (computeBallotHash(b) !== b.currentHash) {
      issues.push({ ...tag, seq: b.seq, receiptCode: b.receiptCode, problem: "HASH_MISMATCH" });
    }
    if (!sealMatches(sealBallot(b.currentHash), b.seal)) {
      issues.push({ ...tag, seq: b.seq, receiptCode: b.receiptCode, problem: "BAD_SEAL" });
    }
    expectedPrev = b.currentHash;
    expectedSeq = b.seq + 1;
  }

  if (head) {
    if (head.seq !== expectedSeq - 1 || (head.seq > 0 && head.lastHash !== expectedPrev)) {
      issues.push({ ...tag, seq: head.seq, receiptCode: "(chain head)", problem: "HEAD_MISMATCH" });
    }
    // An empty genesis head needs no seal; any head that points at ballots does.
    if (head.seq > 0 && !sealMatches(sealHead(head.seq, head.lastHash, chain), head.seal)) {
      issues.push({ ...tag, seq: head.seq, receiptCode: "(chain head)", problem: "BAD_HEAD_SEAL" });
    }
  } else if (ballots.length) {
    // Ballots whose chain head was deleted: the newest ones could have gone with it.
    issues.push({ ...tag, seq: expectedSeq - 1, receiptCode: "(chain head)", problem: "HEAD_MISMATCH" });
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

/**
 * One fingerprint for the whole election: the Merkle root of every county chain's head.
 * Change, add or delete any ballot anywhere and its chain head changes, so this root does
 * too. It can be published (on screen, in a newspaper) and checked by anyone later.
 */
export function merkleRoot(heads: ChainHeadRecord[]): string {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  let level = [...heads]
    .sort((a, z) => a.chain.localeCompare(z.chain))
    .map((h) => sha(`leaf|${h.chain}|${h.seq}|${h.lastHash}`));
  if (!level.length) return sha("leaf|empty");
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha(`node|${level[i]}|${level[i + 1] ?? level[i]}`));
    level = next;
  }
  return level[0];
}

export type LedgerAudit = ChainAudit & { chains: number; merkleRoot: string };

/**
 * Audits the whole ledger: every county chain on its own (hashes, links, seals, head),
 * then the total number of ballots against the voters marked as voted.
 */
export function verifyLedger(ballots: SealedBallot[], heads: ChainHeadRecord[], votersMarkedVoted?: number): LedgerAudit {
  const byChain = new Map<string, SealedBallot[]>();
  for (const b of ballots) {
    const c = b.chain ?? LEGACY_CHAIN;
    if (!byChain.has(c)) byChain.set(c, []);
    byChain.get(c)!.push(b);
  }
  const headOf = new Map(heads.map((h) => [h.chain, h]));
  const issues: ChainIssue[] = [];
  let tampered = 0;
  for (const chain of new Set([...byChain.keys(), ...headOf.keys()])) {
    const list = (byChain.get(chain) ?? []).sort((a, z) => a.seq - z.seq);
    const r = verifyChain(list, headOf.get(chain) ?? null, undefined, chain);
    issues.push(...r.issues);
    tampered += r.tamperedVotes;
  }
  if (votersMarkedVoted !== undefined && votersMarkedVoted !== ballots.length) {
    issues.push({ seq: 0, receiptCode: "(voter register)", problem: "TURNOUT_MISMATCH" });
  }
  return {
    intact: issues.length === 0,
    checked: ballots.length,
    tamperedVotes: tampered,
    issues,
    chains: headOf.size,
    merkleRoot: merkleRoot(heads),
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
