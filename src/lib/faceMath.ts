/** Face identity-vector maths (ArcFace, 512 numbers, cosine similarity; see lib/faceEngine.ts). */

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
 * similarity to the template's average (always the registration frames) and to its
 * closest frame, which may also be a frame learned from a confident earlier login.
 * Learned frames can only help the second half, so they cannot pull the template
 * away from the face that was registered.
 */
export function templateSimilarity(
  t: { mean: ArrayLike<number>; samples?: ArrayLike<number>[] | null; learned?: ArrayLike<number>[] | null },
  probe: ArrayLike<number>
) {
  const toMean = cosineSimilarity(t.mean, probe);
  const frames = [...(t.samples ?? []), ...(t.learned ?? [])];
  if (!frames.length) return toMean;
  return (toMean + Math.max(...frames.map((s) => cosineSimilarity(s, probe)))) / 2;
}

/** A login at least this similar teaches the template the voter's face in today's light. */
export const LEARN_MIN = 0.6;
/** At most this many learned frames per voter. */
export const MAX_LEARNED = 4;

/**
 * Adds a confident login's identity vector to the template's learned frames. When full,
 * it replaces the learned frame most like the new one, so the set stays varied
 * (different light, glasses, haircut) instead of filling with near-copies.
 */
export function learnFrame<T extends { learned?: number[][] }>(t: T, probe: number[]): T {
  const learned = [...(t.learned ?? [])];
  if (learned.length < MAX_LEARNED) learned.push(probe);
  else {
    let most = 0;
    learned.forEach((l, i) => {
      if (cosineSimilarity(l, probe) > cosineSimilarity(learned[most], probe)) most = i;
    });
    learned[most] = probe;
  }
  return { ...t, learned };
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
