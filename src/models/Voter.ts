import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

const passkeySchema = new Schema(
  {
    credentialId: { type: String, required: true },
    publicKey: { type: String, required: true }, // base64url
    counter: { type: Number, default: 0 },
    transports: [String],
  },
  { _id: false }
);

const voterSchema = new Schema(
  {
    idNumber: { type: String, required: true, unique: true, trim: true },
    fullName: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },

    // Human-readable home region (shown in Atlas / on the voter card).
    // Always set on registration; older records are backfilled by the seed.
    county: { type: String },
    constituency: { type: String },
    ward: { type: String },
    // Region codes. These drive ballot routing and are validated against
    // the official IEBC region list on registration.
    countyCode: { type: String, required: true },
    constituencyCode: { type: String, required: true },
    wardCode: { type: String, required: true, index: true },

    // Face template (128-point average + 3-8 enrolled frames), AES-256-GCM
    // encrypted and bound to this idNumber (see lib/biometricVault.ts).
    faceTemplate: { type: String, select: false, default: undefined },
    // Enrollment photo, encrypted the same way.
    photoEnc: { type: String, select: false, default: undefined },
    // Face id in the AWS Rekognition collection, when enrolled through AWS
    // (see lib/awsFace.ts). AWS holds the face vector, tagged with this record's _id.
    awsFaceId: { type: String, select: false, default: undefined },

    // Primary WebAuthn credential ("Fingerprint Unlock"). The full public
    // keys needed to verify a fingerprint assertion live in `passkeys`.
    fingerprintCredentialId: { type: String, default: undefined },
    passkeys: { type: [passkeySchema], select: false, default: [] },

    // scrypt hash of the 4-digit PIN used for *2027# USSD voting.
    ussdPinHash: { type: String, select: false, default: undefined },

    hasVoted: { type: Boolean, default: false, index: true },
    // SECRET BALLOT: rounded DOWN to the hour (see lib/castVote.ts), so it
    // can never be matched against an exact vote_ledger timestamp to
    // reveal how this person voted.
    votedAt: { type: Date, default: undefined },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export type VoterDoc = InferSchemaType<typeof voterSchema>;

export const Voter: Model<VoterDoc> =
  (models.Voter as Model<VoterDoc>) || model<VoterDoc>("Voter", voterSchema, "voters");
