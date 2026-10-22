import { NextResponse, connection, type NextRequest } from "next/server";
import { randomInt } from "node:crypto";
import { auditLedger, type LedgerBlock } from "@/lib/ledger";
import { LEGACY_CHAIN, computeBallotHash, verifyChain } from "@/lib/hashChain";
import { clientIp, lockedFor, recordFailure } from "@/lib/rateLimit";
import { logTamperOnce } from "@/lib/audit";
import { POSITIONS, POSITION_LABELS, type Position } from "@/lib/positions";
import { Candidate } from "@/models/Candidate";

/**
 * GET /api/ledger/audit              full SHA-256 recomputation of the chain
 * GET /api/ledger/audit?simulate=1   "Hacker Tamper Test" for judges
 *
 * The simulation copies the REAL ledger into memory, edits one ballot the
 * way an attacker with database access would, and runs the exact same
 * verifier on the copy. The real database is never modified. (To see the
 * live alarm, edit any vote_ledger document in MongoDB Atlas: the results
 * page turns red within 3 seconds.)
 */
export async function GET(req: NextRequest) {
  await connection();
  const simulate = req.nextUrl.searchParams.get("simulate") === "1";

  // Full audits are CPU-heavy: at most 20 per minute per address.
  const key = `audit:${clientIp(req)}`;
  if (lockedFor(key)) return NextResponse.json({ error: "Too many audit requests. Wait a minute." }, { status: 429 });
  recordFailure(key, 20, 60_000);

  try {
    const started = performance.now();
    const { blocks, heads, audit } = await auditLedger();
    const real = {
      ...audit,
      issues: audit.issues.slice(0, 25),
      ms: Math.round(performance.now() - started),
    };
    if (!simulate) {
      await logTamperOnce(audit.issues.map((i) => `${i.problem} #${i.seq}`), req);
      return NextResponse.json({ audit: real });
    }

    if (blocks.length === 0) {
      return NextResponse.json(
        { audit: real, error: "The ledger is empty. Cast at least one vote, then run the tamper test." },
        { status: 409 }
      );
    }

    // ---- Pick a victim ballot and a seat to flip ---------------------------
    // The attack happens on the victim's county chain (each county is its own chain).
    const pick = blocks[randomInt(blocks.length)];
    const chain = pick.chain ?? LEGACY_CHAIN;
    const chainBlocks = blocks.filter((b) => (b.chain ?? LEGACY_CHAIN) === chain).sort((a, z) => a.seq - z.seq);
    const head = heads.find((h) => h.chain === chain) ?? null;
    const victimIdx = chainBlocks.indexOf(pick);
    const victim = pick;
    const seat: Position = POSITIONS.find((p) => victim.selections[p]) ?? "PRESIDENT";
    const originalId = victim.selections[seat];
    const original = await Candidate.findById(originalId, { name: 1, position: 1, regionCode: 1 }).lean();
    const rival = await Candidate.findOne(
      { _id: { $ne: originalId }, position: original?.position ?? seat, regionCode: original?.regionCode ?? "KE" },
      { name: 1 }
    ).lean();
    const forgedId = rival ? String(rival._id) : "000000000000000000000000";

    const clone = (): LedgerBlock[] => chainBlocks.map((b) => ({ ...b, selections: { ...b.selections } }));

    // Attack 1: flip the vote only.
    const attack1 = clone();
    attack1[victimIdx].selections[seat] = forgedId;
    const result1 = verifyChain(attack1, head, undefined, chain);
    const forgedHash = computeBallotHash(attack1[victimIdx]);

    // Attack 2: flip the vote AND recompute that ballot's hash to hide it.
    const attack2 = clone();
    attack2[victimIdx].selections[seat] = forgedId;
    attack2[victimIdx].currentHash = computeBallotHash(attack2[victimIdx]);
    const result2 = verifyChain(attack2, head, undefined, chain);

    // Attack 3: flip the vote and REWRITE THE WHOLE CHAIN after it (every later
    // hash, every link, and the chain head). Plain SHA-256 cannot catch this;
    // the HMAC seals can, because the attacker does not have the ledger key.
    const attack3 = clone();
    attack3[victimIdx].selections[seat] = forgedId;
    for (let i = victimIdx; i < attack3.length; i++) {
      if (i > victimIdx) attack3[i].previousHash = attack3[i - 1].currentHash;
      attack3[i].currentHash = computeBallotHash(attack3[i]);
    }
    const forgedHead = head
      ? { ...head, seq: attack3[attack3.length - 1].seq, lastHash: attack3[attack3.length - 1].currentHash }
      : null;
    const result3 = verifyChain(attack3, forgedHead, undefined, chain);

    return NextResponse.json({
      audit: real,
      simulation: {
        target: {
          seq: victim.seq,
          county: victim.county ?? null,
          receiptCode: victim.receiptCode,
          seat,
          seatLabel: POSITION_LABELS[seat],
          from: original?.name ?? originalId,
          to: rival?.name ?? "(forged candidate)",
          storedHash: victim.currentHash,
          recomputedHash: forgedHash,
        },
        attackFlipVote: { detected: !result1.intact, issues: result1.issues.slice(0, 5) },
        attackRehash: {
          detected: !result2.intact,
          issues: result2.issues.slice(0, 5),
          note:
            victimIdx < chainBlocks.length - 1
              ? `Ballot #${victim.seq + 1} still points to the ORIGINAL hash, so the link breaks.`
              : "The chain head still records the ORIGINAL hash, so the mismatch is caught.",
        },
        attackRewriteChain: {
          detected: !result3.intact,
          issues: result3.issues.slice(0, 5),
          note: "Every SHA-256 hash and link now looks perfect, but the forger cannot produce valid HMAC seals without the secret ledger key, which is never stored in the database.",
        },
      },
    });
  } catch (err) {
    console.error("Ledger audit failed:", err);
    return NextResponse.json({ error: "The ledger audit could not be completed." }, { status: 500 });
  }
}
