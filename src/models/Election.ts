import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/** Singleton election configuration (opening / closing times). */
const electionSchema = new Schema(
  {
    _id: { type: String, default: "current" },
    name: { type: String, required: true },
    opensAt: { type: Date, required: true },
    closesAt: { type: Date, required: true },
  },
  { versionKey: false, timestamps: true }
);

export type ElectionDoc = InferSchemaType<typeof electionSchema>;
export type ElectionStatus = "UPCOMING" | "OPEN" | "CLOSED";

export function electionStatus(e: Pick<ElectionDoc, "opensAt" | "closesAt">, now = new Date()): ElectionStatus {
  if (now < e.opensAt) return "UPCOMING";
  if (now > e.closesAt) return "CLOSED";
  return "OPEN";
}

export const Election: Model<ElectionDoc> =
  (models.Election as Model<ElectionDoc>) ||
  model<ElectionDoc>("Election", electionSchema, "elections");

/** Election officials who can register voters and manage the election. */
const adminSchema = new Schema(
  {
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
  },
  { versionKey: false, timestamps: true }
);

export type AdminDoc = InferSchemaType<typeof adminSchema>;

export const Admin: Model<AdminDoc> =
  (models.Admin as Model<AdminDoc>) || model<AdminDoc>("Admin", adminSchema, "admins");
