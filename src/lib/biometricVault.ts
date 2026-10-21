import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { biometricKey } from "@/lib/secrets";
import { Voter } from "@/models/Voter";

/**
 * Encryption at rest for biometric data (Kenya Data Protection Act 2019:
 * biometrics are "sensitive personal data").
 *
 * AES-256-GCM with a key that never touches MongoDB. Each blob is bound to
 * its owner's National ID as authenticated data, so copying one voter's
 * encrypted face into another voter's record makes it fail to decrypt
 * (an intruder cannot "swap faces" to vote as someone else).
 */

const VERSION = "v1";

function seal(plain: Buffer, idNumber: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", biometricKey(), iv);
  cipher.setAAD(Buffer.from(`voter:${idNumber}`));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return `${VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
}

function open(blob: string | null | undefined, idNumber: string): Buffer | null {
  if (!blob?.startsWith(`${VERSION}.`)) return null;
  try {
    const raw = Buffer.from(blob.slice(VERSION.length + 1), "base64url");
    const decipher = createDecipheriv("aes-256-gcm", biometricKey(), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(`voter:${idNumber}`));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  } catch {
    return null; // wrong owner, wrong key or tampered ciphertext
  }
}

export type FaceTemplateData = { mean: number[]; samples: number[][] };

export function encryptFaceTemplate(t: FaceTemplateData, idNumber: string): string {
  return seal(Buffer.from(JSON.stringify(t)), idNumber);
}

export function decryptFaceTemplate(blob: string | null | undefined, idNumber: string): FaceTemplateData | null {
  const plain = open(blob, idNumber);
  if (!plain) return null;
  try {
    const t = JSON.parse(plain.toString("utf8")) as FaceTemplateData;
    return Array.isArray(t.mean) && t.mean.length === 128 ? t : null;
  } catch {
    return null;
  }
}

export function encryptPhoto(dataUrl: string, idNumber: string): string {
  return seal(Buffer.from(dataUrl), idNumber);
}

/** Decrypted templates of every enrolled voter except `excludeId` (for 1:N checks). */
export async function enrolledTemplates(excludeId?: unknown): Promise<FaceTemplateData[]> {
  const docs = await Voter.find(
    { faceTemplate: { $exists: true }, ...(excludeId ? { _id: { $ne: excludeId } } : {}) },
    { idNumber: 1, faceTemplate: 1 }
  )
    .select("+faceTemplate")
    .limit(5000)
    .lean();
  return docs.flatMap((d) => decryptFaceTemplate(d.faceTemplate, d.idNumber) ?? []);
}
