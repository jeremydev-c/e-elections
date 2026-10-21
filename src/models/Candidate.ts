import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

import {
  POSITIONS,
  POSITION_LABELS,
  POSITION_LEVEL,
  type Position,
} from "@/lib/positions";

export { POSITIONS, POSITION_LABELS, POSITION_LEVEL, type Position };

const candidateSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    party: { type: String, required: true },
    partyColor: { type: String, default: "#64748b" },
    position: { type: String, enum: POSITIONS, required: true },
    // Human-readable region the seat belongs to. Presidential candidates
    // have none (national race).
    county: { type: String },
    constituency: { type: String },
    ward: { type: String },
    // "KE" for President, otherwise the county / constituency / ward code.
    regionCode: { type: String, required: true },
    photoUrl: { type: String },
    // Fast cache only. Official results are recomputed from the verified
    // vote_ledger, and any drift between the two is flagged as tampering.
    voteCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

candidateSchema.index({ position: 1, regionCode: 1 });

export type CandidateDoc = InferSchemaType<typeof candidateSchema>;

export const Candidate: Model<CandidateDoc> =
  (models.Candidate as Model<CandidateDoc>) ||
  model<CandidateDoc>("Candidate", candidateSchema, "candidates");
