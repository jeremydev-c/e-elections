import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * Security event log. Records FAILURES and ADMIN ACTIONS only.
 * Successful voter verifications and cast votes are deliberately NOT logged
 * with an ID: "ID X verified at 14:02" next to a ballot timestamped 14:03
 * would reveal how that person voted.
 */
const auditLogSchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    event: { type: String, required: true },
    severity: { type: String, enum: ["info", "warning", "critical"], default: "info" },
    actor: { type: String }, // admin username, or "voter" / "system"
    idNumber: { type: String }, // only for failed / blocked attempts
    ip: { type: String },
    detail: { type: String },
  },
  { versionKey: false }
);

// Keep 180 days of history, newest first.
auditLogSchema.index({ at: -1 });
auditLogSchema.index({ at: 1 }, { expireAfterSeconds: 180 * 86_400 });

export type AuditLogDoc = InferSchemaType<typeof auditLogSchema>;

export const AuditLog: Model<AuditLogDoc> =
  (models.AuditLog as Model<AuditLogDoc>) || model<AuditLogDoc>("AuditLog", auditLogSchema, "audit_log");
