import { isValidObjectId } from "mongoose";
import { connectDB, withTransaction } from "@/lib/mongodb";
import { computeBallotHash, generateReceiptCode, GENESIS_HASH, sealBallot, sealHead } from "@/lib/hashChain";
import { POSITIONS, POSITION_LABELS, alreadyVotedMessage, regionCodeFor, type Position } from "@/lib/positions";
import { getCounty } from "@/lib/regions";
import { Voter } from "@/models/Voter";
import { Candidate } from "@/models/Candidate";
import { VoteLedger, ChainHead } from "@/models/VoteLedger";
import { Election, electionStatus } from "@/models/Election";

export class CastError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: "ALREADY_VOTED" | "INVALID_BALLOT" | "CLOSED" | "NOT_FOUND" | "BUSY"
  ) {
    super(message);
  }
}

export type CastReceipt = {
  receiptCode: string;
  seq: number;
  county: string;
  previousHash: string;
  currentHash: string;
  timestamp: string;
};

/** votedAt is stored rounded down to the hour to protect ballot secrecy. */
const hourFloor = (d: Date) => new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000);

/**
 * Casts one voter's complete ballot, all-or-nothing:
 *   1. re-checks on the server that voter.hasVoted === false (atomic lock),
 *   2. validates every selection is a real candidate for that seat in the
 *      voter's own county / constituency / ward,
 *   3. appends an anonymous SHA-256 block to the ledger (compare-and-swap
 *      on the chain head, so concurrent votes can never fork the chain),
 *   4. increments each chosen candidate's cached voteCount.
 * On Atlas this runs in one ACID transaction; nothing is half-applied.
 */
export async function castBallot(voterId: string, raw: Record<string, unknown>): Promise<CastReceipt> {
  await connectDB();

  const election = await Election.findById("current").lean();
  if (election && electionStatus(election) !== "OPEN") {
    throw new CastError("The election voting window is closed.", 403, "CLOSED");
  }

  const voter = await Voter.findById(voterId, {
    idNumber: 1,
    hasVoted: 1,
    votedAt: 1,
    county: 1,
    countyCode: 1,
    constituencyCode: 1,
    wardCode: 1,
  }).lean();
  if (!voter) throw new CastError("Voter record not found.", 404, "NOT_FOUND");
  if (voter.hasVoted) {
    throw new CastError(alreadyVotedMessage(voter.idNumber, voter.votedAt), 409, "ALREADY_VOTED");
  }

  // ---- Validate the ballot against this voter's own region ---------------
  const selections = {} as Record<Position, string>;
  for (const pos of POSITIONS) {
    const id = String(raw?.[pos] ?? "");
    if (!isValidObjectId(id)) {
      throw new CastError(`Please choose a candidate for ${POSITION_LABELS[pos]}.`, 400, "INVALID_BALLOT");
    }
    selections[pos] = id;
  }
  const ids = Object.values(selections);
  const found = await Candidate.find({ _id: { $in: ids } }, { position: 1, regionCode: 1 }).lean();
  const byId = new Map(found.map((c) => [String(c._id), c]));
  for (const pos of POSITIONS) {
    const c = byId.get(selections[pos]);
    if (!c || c.position !== pos || c.regionCode !== regionCodeFor(pos, voter)) {
      throw new CastError(
        `Invalid ${POSITION_LABELS[pos]} selection: that candidate is not on your ballot.`,
        400,
        "INVALID_BALLOT"
      );
    }
  }

  const county = voter.county ?? getCounty(voter.countyCode)?.name ?? voter.countyCode;

  // Make sure the genesis head exists (idempotent; safe under races).
  await ChainHead.updateOne(
    { _id: "main" },
    { $setOnInsert: { seq: 0, lastHash: GENESIS_HASH } },
    { upsert: true }
  ).catch((err) => {
    if ((err as { code?: number }).code !== 11000) throw err;
  });

  return withTransaction(async (session) => {
    // 1. ATOMIC SINGLE-VOTE LOCK: only succeeds while hasVoted is false.
    const locked = await Voter.findOneAndUpdate(
      { _id: voterId, hasVoted: false },
      { $set: { hasVoted: true, votedAt: hourFloor(new Date()) } },
      { session }
    );
    if (!locked) {
      const v = await Voter.findById(voterId, { idNumber: 1, votedAt: 1 }).lean();
      throw new CastError(alreadyVotedMessage(v?.idNumber ?? "", v?.votedAt), 409, "ALREADY_VOTED");
    }

    try {
      // 2. Append to the hash chain. The head only advances if nobody else
      //    advanced it since we read it, otherwise we re-read and retry.
      for (let attempt = 0; attempt < 15; attempt++) {
        const head = await ChainHead.findById("main").session(session ?? null).lean();
        const prevSeq = head?.seq ?? 0;
        const previousHash = head?.lastHash ?? GENESIS_HASH;

        const seq = prevSeq + 1;
        const receiptCode = generateReceiptCode();
        const timestamp = new Date();
        const currentHash = computeBallotHash({ seq, receiptCode, selections, county, timestamp, previousHash });
        const seal = sealBallot(currentHash);

        const advanced = await ChainHead.findOneAndUpdate(
          { _id: "main", seq: prevSeq, lastHash: previousHash },
          { $set: { seq, lastHash: currentHash, seal: sealHead(seq, currentHash) } },
          { session }
        );
        if (!advanced) continue;

        try {
          await VoteLedger.create([{ seq, receiptCode, selections, county, timestamp, previousHash, currentHash, seal }], {
            session,
          });
        } catch (err) {
          if (!session) {
            // No transaction: roll the head back so the chain stays consistent.
            await ChainHead.updateOne(
              { _id: "main", seq, lastHash: currentHash },
              { $set: { seq: prevSeq, lastHash: previousHash, seal: head?.seal ?? undefined } }
            );
          }
          throw err;
        }

        // 3. Cached tallies (results are re-verified against the ledger).
        await Candidate.updateMany({ _id: { $in: ids } }, { $inc: { voteCount: 1 } }, { session });

        return { receiptCode, seq, county, previousHash, currentHash, timestamp: timestamp.toISOString() };
      }
      throw new CastError("The ledger is busy. Please submit your ballot again.", 503, "BUSY");
    } catch (err) {
      if (!session) {
        // No transaction: release the voter lock so they can retry.
        await Voter.updateOne({ _id: voterId }, { $set: { hasVoted: false }, $unset: { votedAt: 1 } });
      }
      throw err;
    }
  });
}
