import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * Cached vote counts, one counter per candidate per county chain (_id "chain:candidateId").
 *
 * A single counter per candidate was the busiest record in the database: every voter in
 * Kenya added 1 to the same presidential candidates inside their transaction, so
 * simultaneous voters kept colliding and retrying. Split by county, a counter is only
 * shared by voters of one county, who already take turns on that county's chain.
 *
 * Like before, these are only a cache: results are counted from the ledger, and a cache
 * that disagrees with the ledger raises the tamper alarm.
 */
const tallyShardSchema = new Schema(
  {
    _id: { type: String },
    candidate: { type: String, required: true, index: true },
    chain: { type: String, required: true },
    votes: { type: Number, default: 0 },
  },
  { versionKey: false }
);

export type TallyShardDoc = InferSchemaType<typeof tallyShardSchema>;

export const TallyShard: Model<TallyShardDoc> =
  (models.TallyShard as Model<TallyShardDoc>) || model<TallyShardDoc>("TallyShard", tallyShardSchema, "tally_shards");

/** Cached votes per candidate id: the county counters added up. */
export async function cachedTallies(): Promise<Map<string, number>> {
  const rows = await TallyShard.aggregate<{ _id: string; votes: number }>([{ $group: { _id: "$candidate", votes: { $sum: "$votes" } } }]);
  return new Map(rows.map((r) => [String(r._id), r.votes]));
}
