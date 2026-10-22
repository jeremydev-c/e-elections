/** Shared face-descriptor math (safe to use on server and client). */

export const DESCRIPTOR_LENGTH = 128;

/**
 * Euclidean distance below which two descriptors are treated as the same person.
 * 0.6 is face-api's usual default; we use a stricter value for voting.
 */
export const FACE_MATCH_THRESHOLD = 0.45;

/** A reading is 3-8 descriptors taken a fraction of a second apart. */
export const MIN_SAMPLES = 3;
export const MAX_SAMPLES = 8;

/** Readings in one login must all be the same face (no swapping mid-scan). */
export const PROBE_CONSISTENCY_LIMIT = 0.55;

/** The claimed voter must beat every other enrolled face by at least this much. */
export const IMPOSTOR_MARGIN = 0.04;

/* ---------- server engine (ArcFace, 512 numbers, cosine similarity; see lib/faceEngine.ts) ---------- */

export const EMBEDDING_LENGTH = 512;

/**
 * Cosine similarity at or above which a live face is the enrolled voter. Calibrated on
 * LFW (scripts/benchmark-lfw.ts) to give zero false accepts with a safety margin.
 */
export const FACE_MATCH_MIN = 0.4;

/** 1:N check: the claimed voter must beat every other registered face by this much. */
export const RIVAL_MARGIN = 0.08;

/** Frames of one scan must agree with each other: frontal frames, and frames with the head turned. */
export const SAME_SCAN_MIN = 0.5;
export const SAME_SCAN_TURNED_MIN = 0.3;

/**
 * Similarity of a live identity vector to an enrolled template: an even blend of the
 * similarity to the template's average and to its closest enrolled frame.
 */
export function templateSimilarity(t: { mean: ArrayLike<number>; samples?: ArrayLike<number>[] | null }, probe: ArrayLike<number>) {
  const toMean = cosineSimilarity(t.mean, probe);
  if (!t.samples?.length) return toMean;
  return (toMean + Math.max(...t.samples.map((s) => cosineSimilarity(s, probe)))) / 2;
}

export function isValidEmbedding(d: unknown): d is number[] {
  return (
    Array.isArray(d) &&
    d.length === EMBEDDING_LENGTH &&
    d.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1)
  );
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return s / (Math.sqrt(na * nb) || 1);
}

/** Average of several unit vectors, rescaled to unit length (the voter's template). */
export function meanEmbedding(vs: ArrayLike<number>[]): number[] {
  const out = new Array<number>(vs[0].length).fill(0);
  for (const v of vs) for (let i = 0; i < out.length; i++) out[i] += v[i];
  const n = Math.sqrt(out.reduce((s, x) => s + x * x, 0)) || 1;
  return out.map((x) => x / n);
}

/* ---------- legacy in-browser engine (face-api, 128 numbers, Euclidean distance) ---------- */

export function isValidDescriptor(d: unknown): d is number[] {
  return (
    Array.isArray(d) &&
    d.length === DESCRIPTOR_LENGTH &&
    d.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 10)
  );
}

export function isValidSampleSet(s: unknown): s is number[][] {
  return Array.isArray(s) && s.length >= MIN_SAMPLES && s.length <= MAX_SAMPLES && s.every(isValidDescriptor);
}

export function faceDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

export type FaceTemplate = { mean: ArrayLike<number>; samples?: ArrayLike<number>[] | null };

/**
 * Distance from one live reading to an enrolled template: an even blend of
 * the distance to the averaged template and to the closest enrolled frame.
 */
export function templateDistance(t: FaceTemplate, probe: ArrayLike<number>): number {
  const toMean = faceDistance(t.mean, probe);
  if (!t.samples?.length) return toMean;
  const toNearest = Math.min(...t.samples.map((s) => faceDistance(s, probe)));
  return (toMean + toNearest) / 2;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, z) => a - z);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Largest distance between any two live readings (same person => small). */
export function probeSpread(probes: ArrayLike<number>[]): number {
  let max = 0;
  for (let i = 0; i < probes.length; i++)
    for (let j = i + 1; j < probes.length; j++) max = Math.max(max, faceDistance(probes[i], probes[j]));
  return max;
}

/**
 * Score of a multi-frame live reading against a template. The median
 * ignores one odd frame (a blink), so a single lucky frame can't pass
 * and a single bad frame can't fail an honest voter.
 */
export function matchScore(t: FaceTemplate, probes: ArrayLike<number>[]): number {
  return median(probes.map((p) => templateDistance(t, p)));
}

