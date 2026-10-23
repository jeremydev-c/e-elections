import { createHmac, timingSafeEqual } from "node:crypto";
import { cardKey } from "@/lib/secrets";

/**
 * Printed voter cards.
 *
 * Card number: KE27-XXXX-XXXX-C. The eight characters come from an HMAC of the
 * voter's record id and card serial, so they can't be guessed or made up, and the
 * last character is a check character that catches a mistyped number.
 *
 * QR code: a link to /card?c=<token>. The token carries the record id and serial
 * plus an HMAC signature. Anyone can scan it; only the server can make one. When a
 * card is reissued the serial goes up and older cards report "replaced".
 *
 * Neither the card number nor the token contains the voter's name or National ID.
 */

// Crockford base32: no I, L, O or U, so nothing can be misread as 1, 0 or V.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const mac = (what: string) => createHmac("sha256", cardKey()).update(what).digest();

function checkChar(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += ALPHABET.indexOf(body[i]) * (i + 1);
  return ALPHABET[sum % 32];
}

export function cardNumber(voterId: string, serial: number): string {
  const bytes = mac(`number|${voterId}|${serial}`);
  let body = "";
  for (let i = 0; i < 8; i++) body += ALPHABET[bytes[i] % 32];
  return `KE27-${body.slice(0, 4)}-${body.slice(4)}-${checkChar(body)}`;
}

/** True when the check character matches, i.e. the number was not mistyped. */
export function cardNumberWellFormed(n: string): boolean {
  const m = /^KE27-([0-9A-HJKMNP-TV-Z]{4})-([0-9A-HJKMNP-TV-Z]{4})-([0-9A-HJKMNP-TV-Z])$/.exec(n.toUpperCase());
  return !!m && checkChar(m[1] + m[2]) === m[3];
}

const sign = (voterId: string, serial: number) => mac(`token|${voterId}|${serial}`).subarray(0, 16).toString("base64url");

export function cardToken(voterId: string, serial: number): string {
  return `1.${voterId}.${serial}.${sign(voterId, serial)}`;
}

/** The record id and serial in a token, or null if the token was not made by this server. */
export function readCardToken(token: string): { voterId: string; serial: number } | null {
  const m = /^1\.([0-9a-f]{24})\.(\d{1,4})\.([A-Za-z0-9_-]{22})$/.exec(token.trim());
  if (!m) return null;
  const serial = Number(m[2]);
  const expected = Buffer.from(sign(m[1], serial));
  const given = Buffer.from(m[3]);
  return expected.length === given.length && timingSafeEqual(expected, given) ? { voterId: m[1], serial } : null;
}

/** "Achieng Wanjiru Otieno" -> "A. W. Otieno": enough for a poll worker to compare with the card. */
export function initialsName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return parts[0] ?? "";
  return [...parts.slice(0, -1).map((p) => `${p[0].toUpperCase()}.`), parts[parts.length - 1]].join(" ");
}
