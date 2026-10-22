/**
 * Active liveness challenge (shared by browser and server).
 *
 * For every face scan the server picks a random order of three moves (turn left,
 * turn right, blink) and signs it into a single-use token (lib/livenessChallenge.ts).
 * The browser guides the voter through them and sends one camera frame at the peak of
 * each move; the server then checks every frame itself (lib/faceScan.ts): the head
 * really turned the requested way, the eyes really closed, and it was the same person
 * throughout.
 *
 * A printed photo or a still on a screen cannot blink or turn on cue, and a
 * pre-recorded video does not know the random order in advance.
 */

export const LIVENESS_STEPS = ["TURN_LEFT", "TURN_RIGHT", "BLINK"] as const;
export type LivenessStep = (typeof LIVENESS_STEPS)[number];

export const LIVENESS = {
  /** Lifetime of a challenge token, in seconds. */
  TOKEN_TTL: 90,
} as const;

/** A random order of all three moves (6 possible orders). */
export function randomSteps(randomInt: (max: number) => number): LivenessStep[] {
  const steps = [...LIVENESS_STEPS];
  for (let i = steps.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [steps[i], steps[j]] = [steps[j], steps[i]];
  }
  return steps;
}
