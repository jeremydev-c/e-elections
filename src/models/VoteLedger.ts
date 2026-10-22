import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * Append-only, SHA-256 hash-chained ballot ledger.
 * SECRET BALLOT: contains NO voter identity (no idNumber, no fullName,
 * no voter _id) — only an anonymous receipt code.
 */
const voteLedgerSchema = new Schema(
  {
    // County chain (county code). Absent on ballots of the original single chain ("main").
    chain: { type: String },
    seq: { type: Number, required: true }, // 1, 2, 3 ... order within its chain
    receiptCode: { type: String, required: true, unique: true },
    // position -> candidate _id (as string)
    selections: { type: Map, of: String },
    // County where the ballot was cast (region-level turnout only).
    county: { type: String },
    timestamp: { type: Date, required: true },
    previousHash: { type: String, required: true },
    currentHash: { type: String, required: true },
    // HMAC-SHA256 server seal of currentHash (key never stored in the DB).
    seal: { type: String },
  },
  { versionKey: false }
);
// One ballot per position in each chain.
voteLedgerSchema.index({ chain: 1, seq: 1 }, { unique: true });

export type VoteLedgerDoc = InferSchemaType<typeof voteLedgerSchema>;

export const VoteLedger: Model<VoteLedgerDoc> =
  (models.VoteLedger as Model<VoteLedgerDoc>) ||
  model<VoteLedgerDoc>("VoteLedger", voteLedgerSchema, "vote_ledger");

/**
 * One document per chain (per county, plus "main" for the original single chain)
 * tracking its tip. Ballots advance it with a compare-and-swap, so two ballots can
 * never claim the same previousHash (no forks), and deleting the newest ballot is
 * detectable. Different counties advance different heads, so they never wait for
 * each other.
 */
const chainHeadSchema = new Schema(
  {
    _id: { type: String, default: "main" },
    seq: { type: Number, default: 0 },
    lastHash: { type: String, required: true },
    // HMAC seal of (seq, lastHash): stops the head being rolled back to hide deleted ballots.
    seal: { type: String },
  },
  { versionKey: false }
);

export type ChainHeadDoc = InferSchemaType<typeof chainHeadSchema>;

export const ChainHead: Model<ChainHeadDoc> =
  (models.ChainHead as Model<ChainHeadDoc>) ||
  model<ChainHeadDoc>("ChainHead", chainHeadSchema, "chain_head");
