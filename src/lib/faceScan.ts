import {
  alignFace,
  brightness,
  decodeImage,
  detectFaces,
  embedAligned,
  landmarks106,
  liveScores,
  portraitCrop,
  sharpness,
  yawOf,
  type Face,
  type Point,
  type RGBImage,
} from "@/lib/faceEngine";
import { SAME_SCAN_MIN, SAME_SCAN_TURNED_MIN, cosineSimilarity, meanEmbedding } from "@/lib/faceMath";
import { LIVENESS_STEPS, type LivenessStep } from "@/lib/liveness";

/**
 * One face scan, checked entirely on the server from the camera frames:
 *
 *   1. FRONT_FRAMES frontal frames, then one frame per liveness move, in the order
 *      the server's challenge asked for (turn left / turn right / eyes closed).
 *   2. Every frame: exactly one clear, sharp, well-lit face.
 *   3. All frames are the same person (no swapping someone in mid-scan).
 *   4. The moves really happened: the head is turned the right way in turn frames
 *      (measured from the 5 keypoints), the eyes are shut in the blink frame
 *      (measured from 106 landmarks, against this person's own open eyes).
 *   5. Passive anti-spoofing scores the frontal frames (photo / screen detection).
 *
 * The result is the voter's identity vector: the average of the frontal frames, and a
 * passport-style photo from the most straight-on of them, eyes open.
 */

export const FRONT_FRAMES = 3;
const MAX_FRAME_BYTES = 400_000;

export const SCAN = {
  /** Detector confidence for "a face is here". */
  MIN_SCORE: 0.6,
  /** Face width in pixels, at the decoded size (frames are scaled to fit 960 px). */
  MIN_FACE_PX: 90,
  /** Frontal frames: nose within this fraction of half the eye distance from centre. */
  FRONT_YAW: 0.35,
  /**
   * Turn frames: the nose must have moved at least this far toward the requested side.
   * (The browser aims for 0.55 and sends the peak of the turn; frontal frames stay under 0.2.)
   */
  TURN_YAW: 0.35,
  /** Blink frame: eye opening below this fraction of the voter's open-eye frames. */
  BLINK_RATIO: 0.6,
  /** Variance of the Laplacian of the aligned face; below = blurred by motion or focus. */
  MIN_SHARPNESS: 25,
  MIN_BRIGHTNESS: 45,
  MAX_BRIGHTNESS: 225,
  /** A second face counts as another person if this confident and at least this big relative to the voter. */
  OTHER_FACE_SCORE: 0.6,
  OTHER_FACE_SIZE: 0.35,
  /** Anti-spoof logit (real - spoof). Recorded on every scan; enforced only with FACE_ANTISPOOF=enforce. */
  LIVE_MIN: 0,
  /**
   * Registration photo (it is printed on the voter card): looking straight into the camera.
   * Pitch is how far down the nose sits between the eye line and the mouth; on 400 LFW photos
   * the median was 0.55, and it moves toward 0.4 when the head tips back and 0.7 when it drops.
   */
  PHOTO_MAX_YAW: 0.12,
  PHOTO_PITCH: 0.55,
  PHOTO_PITCH_TOL: 0.12,
  /** Photo frame's eyes must be at least this open, relative to the widest-open frontal frame. */
  PHOTO_EYES_OPEN: 0.8,
} as const;

/**
 * Head pose from the 5 keypoints, measured in the frame of the eye line, so a head tilted
 * sideways (roll) is not mistaken for one turned (yaw) or tipped (pitch).
 */
export function headPose(face: Face) {
  const [le, re, nose, lm, rm] = face.kps;
  const roll = Math.atan2(re[1] - le[1], re[0] - le[0]);
  const along = (p: Point) => Math.cos(roll) * (p[0] - le[0]) + Math.sin(roll) * (p[1] - le[1]);
  const down = (p: Point) => -Math.sin(roll) * (p[0] - le[0]) + Math.cos(roll) * (p[1] - le[1]);
  const half = Math.max(1, along(re) / 2);
  const mouth = (down(lm) + down(rm)) / 2;
  return {
    yaw: (along(nose) - half) / half,
    pitch: mouth > 0 ? down(nose) / mouth : 0,
    roll: (roll * 180) / Math.PI,
  };
}

export type ScanRole = "FRONT" | LivenessStep;
export type ScanFrame = { role: ScanRole; image: string };

export type ScanProblem =
  | "BAD_FRAMES"
  | "NO_FACE"
  | "MULTIPLE_FACES"
  | "TOO_SMALL"
  | "NOT_FRONTAL"
  | "BLURRY"
  | "TOO_DARK"
  | "TOO_BRIGHT"
  | "MOVE_NOT_DONE"
  | "DIFFERENT_PEOPLE"
  | "SPOOF";

/** What the voter sees for each problem. */
export const SCAN_MESSAGES: Record<ScanProblem, string> = {
  BAD_FRAMES: "The face scan was incomplete. Start it again.",
  NO_FACE: "No face was found in the camera picture. Look straight at the camera.",
  MULTIPLE_FACES: "More than one face was in view. Make sure only you are in the picture.",
  TOO_SMALL: "Your face was too far from the camera. Come a little closer.",
  NOT_FRONTAL: "Look straight at the camera for the start of the scan.",
  BLURRY: "The picture was blurred. Hold the phone still and try again.",
  TOO_DARK: "It is too dark. Face a window or a light and try again.",
  TOO_BRIGHT: "Too much light behind or on your face. Move out of direct light.",
  MOVE_NOT_DONE: "We could not see the moves the screen asked for. Follow the prompts and try again.",
  DIFFERENT_PEOPLE: "The camera saw different people during the scan. Only the voter should be in view.",
  SPOOF: "This looks like a photo or a screen, not a live person.",
};

export type ScanResult =
  | {
      ok: true;
      /** Unit-length average of the frontal frames: the identity vector to match or enrol. */
      embedding: number[];
      /** The individual frontal vectors (kept in the template). */
      frontEmbeddings: number[][];
      /** Small JPEG of the first frontal frame (registration photo). */
      photo: string;
      /** Measurements, for the audit log and tuning. */
      stats: { yaw: number[]; eyeRatio: number | null; liveScore: number; sameScanMin: number; photo: { yaw: number; pitch: number }; ms: number };
    }
  | { ok: false; problem: ScanProblem; detail: string };

type Analysed = { role: ScanRole; img: RGBImage; face: Face; aligned: RGBImage };

const fail = (problem: ScanProblem, detail: string): ScanResult => ({ ok: false, problem, detail });

/** Lower is straighter: turning and tipping both count, tipping a little more. */
const straightness = (p: { yaw: number; pitch: number }) => Math.abs(p.yaw) + 1.5 * Math.abs(p.pitch - SCAN.PHOTO_PITCH);

/** Eye opening from the 106 landmarks: lid gap divided by eye width, both eyes averaged. */
function eyeOpening(pts: Point[]) {
  const eye = (top: number[], bottom: number[], c1: number, c2: number) => {
    const ty = top.reduce((s, i) => s + pts[i][1], 0) / top.length;
    const by = bottom.reduce((s, i) => s + pts[i][1], 0) / bottom.length;
    const w = Math.hypot(pts[c1][0] - pts[c2][0], pts[c1][1] - pts[c2][1]) || 1;
    return Math.abs(by - ty) / w;
  };
  return (eye([40, 41, 42], [33, 36, 37], 35, 39) + eye([94, 95, 96], [87, 90, 91], 89, 93)) / 2;
}

/** The voter's face in a frame, or why there isn't a usable one. */
async function locate(role: ScanRole, image: string): Promise<Analysed | ScanResult> {
  if (typeof image !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > MAX_FRAME_BYTES * 1.4) {
    return fail("BAD_FRAMES", "Frame is not a small JPEG/PNG/WebP data URL");
  }
  let img: RGBImage;
  try {
    img = await decodeImage(image);
  } catch {
    return fail("BAD_FRAMES", "Frame could not be decoded");
  }
  const faces = (await detectFaces(img, 0.4)).filter((f) => f.score >= 0.4);
  const main = faces.sort((a, b) => (b.box[2] - b.box[0]) - (a.box[2] - a.box[0]))[0];
  if (!main || main.score < SCAN.MIN_SCORE) return fail("NO_FACE", `${role}: no confident face`);
  const width = main.box[2] - main.box[0];
  const others = faces.filter(
    (f) => f !== main && f.score >= SCAN.OTHER_FACE_SCORE && f.box[2] - f.box[0] >= width * SCAN.OTHER_FACE_SIZE
  );
  if (others.length) return fail("MULTIPLE_FACES", `${role}: ${others.length + 1} faces`);
  if (width < SCAN.MIN_FACE_PX) return fail("TOO_SMALL", `${role}: face ${Math.round(width)} px wide`);
  const aligned = alignFace(img, main);
  const light = brightness(aligned);
  if (light < SCAN.MIN_BRIGHTNESS) return fail("TOO_DARK", `${role}: brightness ${light.toFixed(0)}`);
  if (light > SCAN.MAX_BRIGHTNESS) return fail("TOO_BRIGHT", `${role}: brightness ${light.toFixed(0)}`);
  if (role === "FRONT") {
    const sharp = sharpness(aligned);
    if (sharp < SCAN.MIN_SHARPNESS) return fail("BLURRY", `${role}: sharpness ${sharp.toFixed(0)}`);
    const yaw = yawOf(main);
    if (Math.abs(yaw) > SCAN.FRONT_YAW) return fail("NOT_FRONTAL", `FRONT: yaw ${yaw.toFixed(2)}`);
  }
  return { role, img, face: main, aligned };
}

/**
 * Checks a whole scan against the liveness moves the server asked for.
 * `steps` comes from the redeemed challenge token, never from the client.
 */
export async function analyseScan(
  frames: unknown,
  steps: LivenessStep[],
  { portrait = false }: { portrait?: boolean } = {}
): Promise<ScanResult> {
  const started = performance.now();
  const roles: ScanRole[] = [...Array<ScanRole>(FRONT_FRAMES).fill("FRONT"), ...steps];
  if (
    !Array.isArray(frames) ||
    frames.length !== roles.length ||
    frames.some((f, i) => !f || typeof f !== "object" || (f as ScanFrame).role !== roles[i]) ||
    steps.some((s) => !LIVENESS_STEPS.includes(s))
  ) {
    return fail("BAD_FRAMES", `Expected frames ${roles.join(",")}`);
  }

  const analysed: Analysed[] = [];
  for (const f of frames as ScanFrame[]) {
    const r = await locate(f.role, f.image);
    if ("ok" in r) return r;
    analysed.push(r);
  }
  const fronts = analysed.filter((a) => a.role === "FRONT");
  const moves = analysed.filter((a) => a.role !== "FRONT");

  // One person throughout: the frontal frames must agree with each other...
  // Flip averaging (fewer false rejections on LFW) only where identity is decided: the frontal
  // frames. The move frames are only compared with them, so one reading each is enough.
  const vecs = [
    ...(await embedAligned(fronts.map((a) => a.aligned), true)),
    ...(await embedAligned(moves.map((a) => a.aligned), false)),
  ];
  const frontVecs = vecs.slice(0, fronts.length);
  const mean = meanEmbedding(frontVecs);
  let sameScanMin = 1;
  for (let i = 0; i < frontVecs.length; i++)
    for (let j = i + 1; j < frontVecs.length; j++) sameScanMin = Math.min(sameScanMin, cosineSimilarity(frontVecs[i], frontVecs[j]));
  if (sameScanMin < SAME_SCAN_MIN) return fail("DIFFERENT_PEOPLE", `Frontal frames only ${sameScanMin.toFixed(2)} alike`);

  // ...the moves really happened. In the raw camera image, a voter turning to THEIR left
  // moves the nose to the image right (yaw > 0)...
  const yaws = analysed.map((a) => yawOf(a.face));
  const open = await Promise.all(fronts.map((f) => landmarks106(f.img, f.face).then(eyeOpening)));
  let eyeRatio: number | null = null;
  for (const m of moves) {
    const yaw = yawOf(m.face);
    if (m.role === "TURN_LEFT" && yaw < SCAN.TURN_YAW) return fail("MOVE_NOT_DONE", `TURN_LEFT: yaw ${yaw.toFixed(2)}`);
    if (m.role === "TURN_RIGHT" && yaw > -SCAN.TURN_YAW) return fail("MOVE_NOT_DONE", `TURN_RIGHT: yaw ${yaw.toFixed(2)}`);
    if (m.role === "BLINK") {
      const closed = eyeOpening(await landmarks106(m.img, m.face));
      const baseline = [...open].sort((a, b) => a - b)[Math.floor(open.length / 2)];
      eyeRatio = baseline > 0 ? closed / baseline : 1;
      if (eyeRatio > SCAN.BLINK_RATIO) return fail("MOVE_NOT_DONE", `BLINK: eyes at ${(eyeRatio * 100).toFixed(0)}% of open`);
    }
  }

  // ...and were done by that same person.
  for (let i = fronts.length; i < vecs.length; i++) {
    const s = cosineSimilarity(vecs[i], mean);
    if (s < SAME_SCAN_TURNED_MIN) return fail("DIFFERENT_PEOPLE", `${analysed[i].role} frame only ${s.toFixed(2)} like the frontal frames`);
    sameScanMin = Math.min(sameScanMin, s);
  }

  // Passive anti-spoofing on the frontal frames (median, so one odd frame doesn't decide).
  const live = (await Promise.all(fronts.map((f) => liveScores(f.img, [f.face]).then((s) => s[0])))).sort((a, b) => a - b);
  const liveScore = live[Math.floor(live.length / 2)];
  if (process.env.FACE_ANTISPOOF === "enforce" && liveScore < SCAN.LIVE_MIN) {
    return fail("SPOOF", `Anti-spoof score ${liveScore.toFixed(2)}`);
  }

  // The photo: the most straight-on frontal frame with the eyes open, cropped like a passport photo.
  const widest = Math.max(...open);
  const best = fronts
    .map((f, i) => ({ f, pose: headPose(f.face), eyes: widest > 0 ? open[i] / widest : 1 }))
    .filter((c) => c.eyes >= SCAN.PHOTO_EYES_OPEN)
    .sort((x, y) => straightness(x.pose) - straightness(y.pose))[0];
  const tooTurned = Math.abs(best.pose.yaw) > SCAN.PHOTO_MAX_YAW;
  const tooTipped = Math.abs(best.pose.pitch - SCAN.PHOTO_PITCH) > SCAN.PHOTO_PITCH_TOL;
  if (portrait && (tooTurned || tooTipped)) {
    return fail("NOT_FRONTAL", `PHOTO: yaw ${best.pose.yaw.toFixed(2)}, pitch ${best.pose.pitch.toFixed(2)}`);
  }
  const crop = portraitCrop(best.f.img, best.f.face);
  const photo = await (await import("sharp")).default(Buffer.from(crop.data), { raw: { width: crop.width, height: crop.height, channels: 3 } })
    .jpeg({ quality: 82 })
    .toBuffer();

  return {
    ok: true,
    embedding: mean,
    frontEmbeddings: frontVecs,
    photo: `data:image/jpeg;base64,${photo.toString("base64")}`,
    stats: {
      yaw: yaws.map((y) => Math.round(y * 100) / 100),
      eyeRatio: eyeRatio === null ? null : Math.round(eyeRatio * 100) / 100,
      liveScore: Math.round(liveScore * 100) / 100,
      sameScanMin: Math.round(sameScanMin * 100) / 100,
      photo: { yaw: Math.round(best.pose.yaw * 100) / 100, pitch: Math.round(best.pose.pitch * 100) / 100 },
      ms: Math.round(performance.now() - started),
    },
  };
}
