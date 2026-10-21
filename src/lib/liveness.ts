/**
 * Active liveness check (shared by browser and server, so both apply the same rules).
 *
 * For every face login the server picks a random order of three moves
 * (turn left, turn right, blink). The browser records the head angle (yaw)
 * and eye openness (eye aspect ratio) frame by frame while the voter does
 * them, plus one face descriptor per move. The server then checks that each
 * move really happened, in the requested order, at human speed, and that the
 * person moving is the same face that is matched afterwards.
 *
 * A printed photo or a still on a screen cannot blink or turn on cue, and a
 * pre-recorded video does not know the random order in advance.
 */
import { faceDistance, isValidDescriptor } from "@/lib/faceMath";

export const LIVENESS_STEPS = ["TURN_LEFT", "TURN_RIGHT", "BLINK"] as const;
export type LivenessStep = (typeof LIVENESS_STEPS)[number];

/** One telemetry reading: client timestamp (ms), head yaw (degrees, + = voter's left), eye aspect ratio. */
export type LivenessFrame = { t: number; yaw: number; ear: number };

export type LivenessStepEvidence = {
  step: LivenessStep;
  frames: LivenessFrame[];
  /** Face descriptor taken during the move, to prove the same person did it. */
  descriptor: number[];
};

export type LivenessEvidence = { steps: LivenessStepEvidence[] };

export const LIVENESS = {
  /** Head must turn at least this far (degrees) for a turn to count. */
  TURN_YAW: 14,
  /** ...starting from a roughly frontal pose (below half of TURN_YAW). */
  START_YAW: 7,
  /** Eyes count as closed below this fraction of the voter's open-eye baseline... */
  BLINK_CLOSED: 0.72,
  /** ...and as open again above this fraction. */
  BLINK_OPEN: 0.88,
  MIN_FRAMES_PER_STEP: 3,
  MAX_FRAMES_PER_STEP: 120,
  /** No human completes a move faster than this. */
  MIN_STEP_MS: 200,
  /** The whole challenge must be done within this time. */
  MAX_TOTAL_MS: 60_000,
  /** Turned or blinking faces drift further from the frontal template, so this is looser than the match threshold. */
  POSE_MATCH_LIMIT: 0.6,
  /** Lifetime of a challenge token, in seconds. */
  TOKEN_TTL: 90,
} as const;

export const STEP_PROMPTS: Record<LivenessStep, string> = {
  TURN_LEFT: "Turn your head to your LEFT",
  TURN_RIGHT: "Turn your head to your RIGHT",
  BLINK: "Close your eyes for a moment, then open them",
};

/** Value below which fraction `q` of the readings fall. */
const percentile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, z) => a - z);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/** Did this sequence of frames contain the requested move? */
export function stepSatisfied(step: LivenessStep, frames: LivenessFrame[]): boolean {
  if (frames.length < LIVENESS.MIN_FRAMES_PER_STEP) return false;

  if (step === "TURN_LEFT" || step === "TURN_RIGHT") {
    const sign = step === "TURN_LEFT" ? 1 : -1;
    // Must start near frontal, then turn the requested way: proves movement, not a fixed angled photo.
    const startAt = frames.findIndex((f) => f.yaw * sign < LIVENESS.START_YAW);
    if (startAt < 0) return false;
    return frames.slice(startAt + 1).some((f) => f.yaw * sign >= LIVENESS.TURN_YAW);
  }

  // BLINK: open -> closed -> open, measured against this voter's own open-eye baseline
  // (80th percentile, so a long eye closure doesn't drag the baseline down).
  const baseline = percentile(frames.map((f) => f.ear), 0.8);
  if (!(baseline > 0)) return false;
  const closed = LIVENESS.BLINK_CLOSED * baseline;
  const open = LIVENESS.BLINK_OPEN * baseline;
  const firstOpen = frames.findIndex((f) => f.ear >= open);
  if (firstOpen < 0) return false;
  const closedAt = frames.findIndex((f, i) => i > firstOpen && f.ear <= closed);
  if (closedAt < 0) return false;
  return frames.some((f, i) => i > closedAt && f.ear >= open);
}

const validFrame = (f: unknown): f is LivenessFrame => {
  const x = f as LivenessFrame;
  return (
    !!x &&
    [x.t, x.yaw, x.ear].every((n) => typeof n === "number" && Number.isFinite(n)) &&
    Math.abs(x.yaw) <= 90 &&
    x.ear >= 0 &&
    x.ear <= 1
  );
};

export type LivenessResult = { ok: true } | { ok: false; reason: string };

/**
 * Server-side check of the evidence against the challenge it issued.
 * `frontal` are the frontal readings that will be matched to the template.
 */
export function verifyLiveness(expected: LivenessStep[], evidence: unknown, frontal: number[][]): LivenessResult {
  const ev = evidence as LivenessEvidence;
  if (!ev || !Array.isArray(ev.steps) || ev.steps.length !== expected.length) {
    return { ok: false, reason: "Liveness evidence missing or incomplete" };
  }

  const frontalMean = frontal[0].map((_, i) => frontal.reduce((s, p) => s + p[i], 0) / frontal.length);
  let lastT = -Infinity;
  let firstT = Infinity;

  for (let k = 0; k < expected.length; k++) {
    const s = ev.steps[k];
    if (!s || s.step !== expected[k]) return { ok: false, reason: "Moves done in the wrong order" };
    const frames = s.frames;
    if (
      !Array.isArray(frames) ||
      frames.length < LIVENESS.MIN_FRAMES_PER_STEP ||
      frames.length > LIVENESS.MAX_FRAMES_PER_STEP ||
      !frames.every(validFrame)
    ) {
      return { ok: false, reason: `Malformed telemetry for ${s.step}` };
    }
    for (const f of frames) {
      if (f.t <= lastT) return { ok: false, reason: "Telemetry timestamps out of order" };
      lastT = f.t;
    }
    firstT = Math.min(firstT, frames[0].t);
    if (frames[frames.length - 1].t - frames[0].t < LIVENESS.MIN_STEP_MS) {
      return { ok: false, reason: `${s.step} completed faster than humanly possible` };
    }
    if (!stepSatisfied(s.step, frames)) return { ok: false, reason: `${s.step} movement not detected` };
    if (!isValidDescriptor(s.descriptor)) return { ok: false, reason: `No face reading during ${s.step}` };
    if (faceDistance(s.descriptor, frontalMean) > LIVENESS.POSE_MATCH_LIMIT) {
      return { ok: false, reason: `A different face performed ${s.step}` };
    }
  }

  if (lastT - firstT > LIVENESS.MAX_TOTAL_MS) return { ok: false, reason: "Liveness challenge took too long" };
  return { ok: true };
}

/** A random order of all three moves (6 possible orders). */
export function randomSteps(randomInt: (max: number) => number): LivenessStep[] {
  const steps = [...LIVENESS_STEPS];
  for (let i = steps.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [steps[i], steps[j]] = [steps[j], steps[i]];
  }
  return steps;
}
