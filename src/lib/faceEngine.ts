import path from "node:path";
import { existsSync } from "node:fs";
import sharp from "sharp";
import * as ort from "onnxruntime-node";

/**
 * Server-side face engine (the same design as cloud face services):
 *
 *   detect      SCRFD-10GF            face box + 5 keypoints (eyes, nose, mouth corners)
 *   align       similarity transform  the 5 keypoints are warped onto the standard ArcFace
 *                                     112x112 template, so every face is compared in the same pose
 *   embed       ArcFace ResNet-50     512-number identity vector (trained on WebFace600K;
 *               @ WebFace600K         90.3% TAR on African faces at a 1-in-a-million false-accept rate)
 *   landmarks   2d106det              106 points, used for eye openness (blink check)
 *   anti-spoof  MiniFASNetV2-SE       real skin vs a photo or a screen (98.2% on CelebA-Spoof)
 *
 * The browser never computes or sends face numbers: it sends camera frames, and every
 * check runs here, where a voter cannot tamper with it.
 *
 * Weights live in ml-models/ (scripts/fetch-face-models.ts). The InsightFace models are
 * licensed for non-commercial research only; a deployment needs a commercial licence.
 */

export const EMBEDDING_SIZE = 512;
// Read at run time from the server folder (turbopackIgnore: not files the build should bundle or trace).
const MODEL_DIR = process.env.FACE_MODEL_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), "ml-models");
const MODELS = {
  detector: "det_10g.onnx",
  recognizer: "w600k_r50.onnx",
  landmarks: "2d106det.onnx",
  antispoof: "antispoof_minifasv2se.onnx",
} as const;

export type RGBImage = { data: Uint8Array; width: number; height: number };
export type Point = [number, number];
export type Face = { box: [number, number, number, number]; score: number; kps: Point[] };

/* ---------------------------------------------------------------- sessions */

type Sessions = Record<keyof typeof MODELS, ort.InferenceSession>;
const globalForEngine = globalThis as unknown as { _faceSessions?: Promise<Sessions> };

export function faceModelsInstalled() {
  return Object.values(MODELS).every((f) => existsSync(path.join(/* turbopackIgnore: true */ MODEL_DIR, f)));
}

/**
 * The recognizer (ResNet-50, the heavy one) runs on the GPU through DirectML on Windows:
 * 52 ms a face instead of 211 ms on a laptop CPU. Elsewhere, or if the GPU fails, the CPU.
 * Set FACE_GPU=off to force the CPU.
 */
const GPU = process.platform === "win32" && process.env.FACE_GPU !== "off";

async function load(file: string, gpu: boolean) {
  const opts: ort.InferenceSession.SessionOptions = { graphOptimizationLevel: "all", logSeverityLevel: 3 };
  if (gpu) {
    try {
      return await ort.InferenceSession.create(path.join(/* turbopackIgnore: true */ MODEL_DIR, file), { ...opts, executionProviders: ["dml", "cpu"] });
    } catch {
      // No usable GPU: fall through to the CPU.
    }
  }
  return ort.InferenceSession.create(path.join(/* turbopackIgnore: true */ MODEL_DIR, file), opts);
}

/** Loads the four networks once per server process (~1-2 s the first time). */
export function sessions(): Promise<Sessions> {
  return (globalForEngine._faceSessions ??= (async () => {
    const [detector, recognizer, landmarks, antispoof] = await Promise.all([
      load(MODELS.detector, false),
      load(MODELS.recognizer, GPU),
      load(MODELS.landmarks, false),
      load(MODELS.antispoof, false),
    ]);
    return { detector, recognizer, landmarks, antispoof };
  })().catch((err) => {
    globalForEngine._faceSessions = undefined;
    throw err;
  }));
}

/**
 * Loads the models and runs each once on a blank picture, so the first voter of the day
 * doesn't wait ~2 s for model loading and GPU shader compilation. Called at server start.
 */
export async function warmUpFaceEngine() {
  if (!faceModelsInstalled()) return;
  const s = await sessions();
  const blank = (size: number) => new ort.Tensor("float32", new Float32Array(3 * size * size), [1, 3, size, size]);
  await s.detector.run({ [s.detector.inputNames[0]]: blank(DET_SIZE) });
  await s.recognizer.run({ [s.recognizer.inputNames[0]]: blank(112) });
  await s.landmarks.run({ [s.landmarks.inputNames[0]]: blank(LMK_SIZE) });
  await s.antispoof.run({ [s.antispoof.inputNames[0]]: blank(128) });
}

/* ---------------------------------------------------------------- images */

/** Decodes a JPEG/PNG (data URL or bytes) to raw RGB, upright, at most `maxSide` pixels. */
export async function decodeImage(input: string | Uint8Array, maxSide = 960): Promise<RGBImage> {
  const bytes =
    typeof input === "string" ? Buffer.from(input.slice(input.indexOf(",") + 1), "base64") : Buffer.from(input);
  const { data, info } = await sharp(bytes, { failOn: "error" })
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

/**
 * Warps `img` with the affine map M (output -> source is computed by inverting it) into a
 * size x size crop. M maps source coordinates to crop coordinates: [a, b, tx, c, d, ty].
 */
/**
 * Bilinear warp of img through the 2x3 matrix M into a size x size (or [width, height])
 * image. Outside the source is black, or the nearest edge pixel when clampEdges is set.
 */
function warpAffine(img: RGBImage, M: number[], size: number | [number, number], clampEdges = false): RGBImage {
  const [a, b, tx, c, d, ty] = M;
  const det = a * d - b * c;
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  const { data, width: W, height: H } = img;
  const [ow, oh] = typeof size === "number" ? [size, size] : size;
  const out = new Uint8Array(ow * oh * 3);
  for (let v = 0; v < oh; v++) {
    for (let u = 0; u < ow; u++) {
      let x = ia * (u - tx) + ib * (v - ty);
      let y = ic * (u - tx) + id * (v - ty);
      if (clampEdges) {
        x = Math.min(Math.max(x, 0), W - 1.001);
        y = Math.min(Math.max(y, 0), H - 1.001);
      }
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= W || y0 + 1 >= H) continue; // outside: black
      const fx = x - x0;
      const fy = y - y0;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      const i00 = (y0 * W + x0) * 3, i10 = i00 + 3, i01 = i00 + W * 3, i11 = i01 + 3;
      const o = (v * ow + u) * 3;
      out[o] = data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11;
      out[o + 1] = data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11;
      out[o + 2] = data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11;
    }
  }
  return { data: out, width: ow, height: oh };
}

/** RGB HWC bytes -> float32 NCHW with (x - mean) / std. */
function toTensor(imgs: RGBImage[], mean: number, std: number) {
  const { width: w, height: h } = imgs[0];
  const plane = w * h;
  const out = new Float32Array(imgs.length * 3 * plane);
  imgs.forEach((img, n) => {
    const base = n * 3 * plane;
    for (let i = 0; i < plane; i++) {
      out[base + i] = (img.data[i * 3] - mean) / std;
      out[base + plane + i] = (img.data[i * 3 + 1] - mean) / std;
      out[base + 2 * plane + i] = (img.data[i * 3 + 2] - mean) / std;
    }
  });
  return new ort.Tensor("float32", out, [imgs.length, 3, h, w]);
}

/* ---------------------------------------------------------------- detection (SCRFD) */

// Selfie faces are large, so 320 px is plenty (39 ms vs 128 ms at 640 on a laptop CPU).
const DET_SIZE = 320;
const STRIDES = [8, 16, 32];
const ANCHORS = 2;

function iou(a: Face["box"], b: Face["box"]) {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = w * h;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter);
}

/** All faces in the image, best first: boxes, confidence and the 5 keypoints. */
export async function detectFaces(img: RGBImage, threshold = 0.5): Promise<Face[]> {
  const { detector } = await sessions();
  // Letterbox into DET_SIZE x DET_SIZE (image at the top-left, rest black), resized natively.
  const scale = Math.min(DET_SIZE / img.width, DET_SIZE / img.height);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const { data } = await sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 3 } })
    .resize(w, h, { fit: "fill" })
    .extend({ right: DET_SIZE - w, bottom: DET_SIZE - h, background: { r: 0, g: 0, b: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const input = toTensor([{ data: new Uint8Array(data), width: DET_SIZE, height: DET_SIZE }], 127.5, 128);
  const out = await detector.run({ [detector.inputNames[0]]: input });
  const outs = detector.outputNames.map((n) => out[n].data as Float32Array);

  const faces: Face[] = [];
  STRIDES.forEach((stride, i) => {
    const scores = outs[i];
    const boxes = outs[i + 3];
    const kps = outs[i + 6];
    const fw = Math.ceil(DET_SIZE / stride);
    for (let k = 0; k < scores.length; k++) {
      if (scores[k] < threshold) continue;
      const cell = Math.floor(k / ANCHORS);
      const cx = (cell % fw) * stride;
      const cy = Math.floor(cell / fw) * stride;
      const d = (j: number) => boxes[k * 4 + j] * stride;
      const box: Face["box"] = [(cx - d(0)) / scale, (cy - d(1)) / scale, (cx + d(2)) / scale, (cy + d(3)) / scale];
      const pts: Point[] = [];
      for (let p = 0; p < 5; p++) {
        pts.push([(cx + kps[k * 10 + p * 2] * stride) / scale, (cy + kps[k * 10 + p * 2 + 1] * stride) / scale]);
      }
      faces.push({ box, score: scores[k], kps: pts });
    }
  });

  faces.sort((a, b) => b.score - a.score);
  const kept: Face[] = [];
  for (const f of faces) if (kept.every((k) => iou(k.box, f.box) < 0.4)) kept.push(f);
  return kept;
}

/* ---------------------------------------------------------------- alignment + embedding (ArcFace) */

/** The standard ArcFace 112x112 positions of: left eye, right eye, nose, left and right mouth corners. */
const ARCFACE_DST: Point[] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

/**
 * Least-squares similarity transform (rotation, uniform scale, translation) mapping
 * src points onto dst points: x' = a*x - b*y + tx, y' = b*x + a*y + ty.
 */
export function similarityTransform(src: Point[], dst: Point[]): number[] {
  const n = src.length;
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    sx += src[i][0]; sy += src[i][1]; dx += dst[i][0]; dy += dst[i][1];
  }
  sx /= n; sy /= n; dx /= n; dy /= n;
  let num1 = 0, num2 = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i][0] - sx, y = src[i][1] - sy;
    const u = dst[i][0] - dx, v = dst[i][1] - dy;
    num1 += x * u + y * v;
    num2 += x * v - y * u;
    den += x * x + y * y;
  }
  const a = num1 / den;
  const b = num2 / den;
  return [a, -b, dx - a * sx + b * sy, b, a, dy - b * sx - a * sy];
}

/**
 * A passport-style portrait: rotated so the eyes are level, scaled so the eyes sit 24%
 * of the width apart and 47% down, which leaves the whole head and the top of the shoulders.
 */
export function portraitCrop(img: RGBImage, face: Face, width = 300, height = 375): RGBImage {
  const half = 0.12 * width;
  const eyeY = 0.47 * height;
  const M = similarityTransform(face.kps.slice(0, 2), [[width / 2 - half, eyeY], [width / 2 + half, eyeY]]);
  return warpAffine(img, M, [width, height], true);
}

/** The face warped onto the ArcFace template (112x112 RGB). */
export function alignFace(img: RGBImage, face: Face): RGBImage {
  return warpAffine(img, similarityTransform(face.kps, ARCFACE_DST), 112);
}

function l2normalize(v: Float32Array) {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return Array.from(v, (x) => x / n);
}

/** 512-number identity vectors (unit length) for aligned faces. One at a time: the exported model has a fixed batch of 1. */
export async function embedAligned(aligned: RGBImage[], flip = FLIP_AVERAGE): Promise<number[][]> {
  const { recognizer } = await sessions();
  const run = async (a: RGBImage) =>
    (await recognizer.run({ [recognizer.inputNames[0]]: toTensor([a], 127.5, 127.5) }))[recognizer.outputNames[0]].data as Float32Array;
  const out: number[][] = [];
  for (const a of aligned) {
    const v = await run(a);
    if (flip) {
      // Flip averaging: also read the mirror image and add the two vectors, so lighting
      // from one side or a slight head turn moves the result less.
      const m = await run(mirror(a));
      for (let i = 0; i < v.length; i++) v[i] += m[i];
    }
    out.push(l2normalize(v));
  }
  return out;
}

/** Read every face twice (as is and mirrored) and average. FACE_FLIP=off to disable. */
const FLIP_AVERAGE = process.env.FACE_FLIP !== "off";

function mirror(img: RGBImage): RGBImage {
  const { data, width: w, height: h } = img;
  const out = new Uint8Array(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3;
      const d = (y * w + (w - 1 - x)) * 3;
      out[d] = data[s];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s + 2];
    }
  }
  return { data: out, width: w, height: h };
}

/** Cosine similarity of two unit vectors (1 = identical, ~0 = unrelated people). */
export function cosine(a: number[], b: number[]) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/* ---------------------------------------------------------------- 106 landmarks (eyes) */

const LMK_SIZE = 192;

/** 106 facial landmarks in image coordinates. */
export async function landmarks106(img: RGBImage, face: Face): Promise<Point[]> {
  const { landmarks } = await sessions();
  const [x1, y1, x2, y2] = face.box;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const s = LMK_SIZE / (Math.max(x2 - x1, y2 - y1) * 1.5);
  const M = [s, 0, LMK_SIZE / 2 - cx * s, 0, s, LMK_SIZE / 2 - cy * s];
  const crop = warpAffine(img, M, LMK_SIZE);
  const out = await landmarks.run({ [landmarks.inputNames[0]]: toTensor([crop], 0, 1) });
  const pred = out[landmarks.outputNames[0]].data as Float32Array;
  const pts: Point[] = [];
  for (let i = 0; i < 106; i++) {
    const u = (pred[i * 2] + 1) * (LMK_SIZE / 2);
    const v = (pred[i * 2 + 1] + 1) * (LMK_SIZE / 2);
    pts.push([(u - M[2]) / s, (v - M[5]) / s]);
  }
  return pts;
}

/* ---------------------------------------------------------------- anti-spoofing (MiniFASNet) */

/** Square crop 1.5x the face box with mirrored edges, resized to 128x128 (the model's training crop). */
async function spoofCrop(img: RGBImage, face: Face): Promise<RGBImage> {
  const [x1, y1, x2, y2] = face.box;
  const side = Math.round(Math.max(x2 - x1, y2 - y1) * 1.5);
  const left = Math.round((x1 + x2) / 2 - side / 2);
  const top = Math.round((y1 + y2) / 2 - side / 2);
  const cx1 = Math.max(0, left);
  const cy1 = Math.max(0, top);
  const cx2 = Math.min(img.width, left + side);
  const cy2 = Math.min(img.height, top + side);
  const { data } = await sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 3 } })
    .extract({ left: cx1, top: cy1, width: Math.max(1, cx2 - cx1), height: Math.max(1, cy2 - cy1) })
    .extend({
      top: cy1 - top,
      left: cx1 - left,
      bottom: Math.max(0, top + side - cy2),
      right: Math.max(0, left + side - cx2),
      extendWith: "mirror",
    })
    .resize(128, 128, { fit: "fill", kernel: side < 128 ? "lanczos3" : "mitchell" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: 128, height: 128 };
}

/**
 * How "real" each face looks: logit(real) - logit(spoof). Above 0 the model judges the
 * face real; photos and phone screens score well below 0.
 */
export async function liveScores(img: RGBImage, faces: Face[]): Promise<number[]> {
  if (!faces.length) return [];
  const { antispoof } = await sessions();
  const crops = await Promise.all(faces.map((f) => spoofCrop(img, f)));
  const out = await antispoof.run({ [antispoof.inputNames[0]]: toTensor(crops, 0, 255) });
  const logits = out[antispoof.outputNames[0]].data as Float32Array;
  return faces.map((_, i) => logits[i * 2] - logits[i * 2 + 1]);
}

/* ---------------------------------------------------------------- measurements */

/**
 * Head turn from the 5 keypoints: where the nose sits between the eyes, -1..1.
 * In the raw (un-mirrored) camera image, positive = nose toward the image right,
 * which is the person turning to THEIR left.
 */
export function yawOf(face: Face) {
  const [le, re, nose] = face.kps;
  const mid = (le[0] + re[0]) / 2;
  const half = Math.max(1, (re[0] - le[0]) / 2);
  return (nose[0] - mid) / half;
}

/** Sharpness: variance of the Laplacian of the aligned face (low = blurry). */
export function sharpness(aligned: RGBImage) {
  const { data, width: w, height: h } = aligned;
  const g = (x: number, y: number) => {
    const i = (y * w + x) * 3;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const l = g(x - 1, y) + g(x + 1, y) + g(x, y - 1) + g(x, y + 1) - 4 * g(x, y);
      sum += l; sum2 += l * l; n++;
    }
  }
  return sum2 / n - (sum / n) ** 2;
}

/** Mean brightness of the aligned face, 0-255. */
export function brightness(aligned: RGBImage) {
  let s = 0;
  for (let i = 0; i < aligned.data.length; i += 3) s += 0.299 * aligned.data[i] + 0.587 * aligned.data[i + 1] + 0.114 * aligned.data[i + 2];
  return s / (aligned.data.length / 3);
}
