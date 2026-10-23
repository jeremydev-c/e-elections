/**
 * Banknote-style security lines for the printed voter card.
 *
 * Everything is drawn from the card number, so every card gets its own rosette and
 * wave pattern, and the public card check (/card) can redraw exactly the pattern a
 * genuine card must carry. A photocopy keeps the pattern; a home-made card with a
 * real card number but a different design does not match it.
 *
 * Pure maths, no Node APIs: used both by the card and by the check page.
 */

// FNV-1a: a small, stable string hash to seed the generator.
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32: a seeded random generator, so the same card number always draws the same lines.
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const f = (n: number) => n.toFixed(2);

export type Rosette = { d: string; color: string; width: number };
export type Guilloche = { rosettes: Rosette[]; waves: string[]; tint: string };

const INKS = ["#0b5d3b", "#b4261c", "#bf891d", "#2f4a6d", "#6b3d7a"];

/**
 * A hypotrochoid: the curve a pen traces when a small wheel rolls inside a big one,
 * the same idea as the rosettes on shilling notes. Integer radii make it close on itself.
 */
function rosette(cx: number, cy: number, size: number, R: number, r: number, k: number): string {
  const turns = r / gcd(R, r);
  const steps = Math.min(2400, 220 * turns);
  const d = k * r;
  const scale = size / (R - r + d);
  let path = "";
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI * turns;
    const x = cx + scale * ((R - r) * Math.cos(t) + d * Math.cos(((R - r) / r) * t));
    const y = cy + scale * ((R - r) * Math.sin(t) - d * Math.sin(((R - r) / r) * t));
    path += `${i ? "L" : "M"}${f(x)} ${f(y)}`;
  }
  return path;
}

/** Lines for a card face of width w and height h (any unit; the card uses an 856 × 540 box). */
export function guilloche(cardNumber: string, w: number, h: number, face: "front" | "back"): Guilloche {
  const rand = rng(hash(`${cardNumber}|${face}`));
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const main = pick(INKS);
  const second = pick(INKS.filter((c) => c !== main));

  const cx = face === "front" ? w * (0.7 + rand() * 0.12) : w * (0.24 + rand() * 0.1);
  const cy = h * (0.45 + rand() * 0.15);
  const size = h * (0.42 + rand() * 0.1);
  const R1 = 9 + Math.floor(rand() * 14);
  const r1 = 2 + Math.floor(rand() * (R1 - 3));
  const R2 = 7 + Math.floor(rand() * 12);
  const r2 = 2 + Math.floor(rand() * (R2 - 3));

  const rosettes: Rosette[] = [
    { d: rosette(cx, cy, size, R1, r1, 0.45 + rand() * 0.5), color: main, width: 0.9 },
    { d: rosette(cx, cy, size * 0.62, R2, r2, 0.4 + rand() * 0.55), color: second, width: 0.7 },
  ];

  // Fine sine waves across the card, like the background print on a cheque.
  const waves: string[] = [];
  const lines = 14;
  const freq = 2 + rand() * 3;
  const amp = h * (0.02 + rand() * 0.03);
  const phase = rand() * Math.PI * 2;
  for (let n = 0; n < lines; n++) {
    const y0 = (h / (lines + 1)) * (n + 1);
    let p = "";
    for (let x = 0; x <= w; x += 8) {
      const y = y0 + amp * Math.sin((x / w) * Math.PI * 2 * freq + phase + n * 0.42);
      p += `${x ? "L" : "M"}${f(x)} ${f(y)}`;
    }
    waves.push(p);
  }
  return { rosettes, waves, tint: main };
}
