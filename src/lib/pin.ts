export const PIN_RE = /^\d{4}$/;

/** PINs a voter may not choose because they are trivially guessable. */
const WEAK_PINS = new Set(["0000", "1111", "1234", "4321", "2027", "9999", "1212", "2580"]);

export function pinProblem(pin: string): string | null {
  if (!PIN_RE.test(pin)) return "USSD PIN must be exactly 4 digits.";
  if (WEAK_PINS.has(pin)) return "That PIN is too easy to guess. Choose a different 4-digit PIN.";
  return null;
}

/** "Wanjiru Akinyi Kamau" -> "Wanjiru A. K." (confirms identity without exposing it). */
export function maskName(fullName: string): string {
  const [first, ...rest] = fullName.trim().split(/\s+/);
  return [first, ...rest.map((p) => `${p[0]?.toUpperCase()}.`)].join(" ");
}
