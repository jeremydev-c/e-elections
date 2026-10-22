import { NextResponse, type NextRequest } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { VoteLedger } from "@/models/VoteLedger";
import { chainGenesis, computeBallotHash, sealBallot, sealMatches } from "@/lib/hashChain";
import { normalizeBlock } from "@/lib/ledger";
import { clientIp, lockedFor, recordFailure } from "@/lib/rateLimit";

/**
 * GET /api/ledger/verify?receiptCode=KE-2027-XXXX-XXXX
 * Public receipt check: proves the ballot is in the ledger, untouched and
 * correctly chained, WITHOUT revealing who it was for (no vote buying:
 * a receipt can't be used to prove to anyone how you voted).
 */
export async function GET(req: NextRequest) {
  const receiptCode = String(req.nextUrl.searchParams.get("receiptCode") ?? "")
    .trim()
    .toUpperCase();
  if (!/^KE-2027-[A-Z0-9]{3,5}-[A-Z0-9]{3,5}$/.test(receiptCode)) {
    return NextResponse.json({ found: false, error: "Enter a receipt code like KE-2027-8F9A-K7QX." }, { status: 400 });
  }

  const ipKey = `receipt:${clientIp(req)}`;
  if (lockedFor(ipKey)) {
    return NextResponse.json({ found: false, error: "Too many unknown receipt codes. Wait 10 minutes." }, { status: 429 });
  }

  await connectDB();
  const raw = await VoteLedger.findOne({ receiptCode }).lean();
  if (!raw) {
    recordFailure(ipKey, 15, 10 * 60_000);
    return NextResponse.json(
      { found: false, error: "Receipt code not found in the ledger. Check the code and try again." },
      { status: 404 }
    );
  }
  const block = normalizeBlock(raw);

  const recomputedHash = computeBallotHash(block);
  const hashValid = recomputedHash === block.currentHash;
  const sealValid = sealMatches(sealBallot(block.currentHash), block.seal);

  // Neighbours on the same (county) chain.
  const chain = block.chain ?? null;
  let parentValid: boolean;
  if (block.seq === 1) {
    parentValid = block.previousHash === chainGenesis(block.chain);
  } else {
    const parent = await VoteLedger.findOne({ chain, seq: block.seq - 1 }, { currentHash: 1 }).lean();
    parentValid = !!parent && parent.currentHash === block.previousHash;
  }
  const child = await VoteLedger.findOne({ chain, seq: block.seq + 1 }, { previousHash: 1 }).lean();
  const childValid = !child || child.previousHash === block.currentHash;

  return NextResponse.json({
    found: true,
    verified: hashValid && sealValid && parentValid && childValid,
    block: {
      seq: block.seq,
      receiptCode: block.receiptCode,
      county: block.county ?? null,
      timestamp: block.timestamp,
      previousHash: block.previousHash,
      currentHash: block.currentHash,
      recomputedHash,
      seatsCount: Object.keys(block.selections).length,
    },
    proof: {
      hashIntegrity: hashValid,
      serverSealValid: sealValid,
      parentLinkIntact: parentValid,
      childLinkIntact: childValid,
      algorithm: "SHA-256",
      isChained: true,
    },
  });
}
