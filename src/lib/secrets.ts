import { createHash, createHmac } from "node:crypto";

/**
 * Server-only keys. They live in environment variables, never in MongoDB,
 * so someone who steals or edits the database still cannot forge ledger
 * seals or read biometric templates.
 *
 * Set LEDGER_SECRET and BIOMETRIC_KEY (32+ random characters each) in
 * production. If they are missing, separate keys are derived from
 * SESSION_SECRET with domain separation so the demo still runs.
 * Changing a key later makes existing seals / templates unverifiable.
 */
function key(envName: string, label: string): Buffer {
  const explicit = process.env[envName];
  if (explicit && explicit.length >= 32) return createHash("sha256").update(explicit).digest();

  const base = process.env.SESSION_SECRET;
  if (!base || base.length < 32) {
    throw new Error(`${envName} (or SESSION_SECRET) must be set to at least 32 characters in .env.local.`);
  }
  return createHmac("sha256", base).update(`e-elections:${label}`).digest();
}

let ledger: Buffer | undefined;
let biometric: Buffer | undefined;
let card: Buffer | undefined;

export const ledgerKey = () => (ledger ??= key("LEDGER_SECRET", "ledger-seal-v1"));
export const biometricKey = () => (biometric ??= key("BIOMETRIC_KEY", "biometric-aes-256-gcm-v1"));
export const cardKey = () => (card ??= key("CARD_SECRET", "voter-card-v1"));
