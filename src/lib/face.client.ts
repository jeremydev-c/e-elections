"use client";

import { faceDistance } from "@/lib/faceMath";

/**
 * High-performance browser face recognition, live tracking & biometric telemetry
 * using @vladmandic/face-api with WebGL hardware acceleration.
 */
type FaceApi = typeof import("@vladmandic/face-api");

let apiPromise: Promise<FaceApi> | null = null;
let modelsLoaded = false;

/** Preloads models in the background without blocking the UI. */
export function preloadFaceApi(): Promise<FaceApi> {
  return loadFaceApi();
}

export function isModelsLoaded(): boolean {
  return modelsLoaded;
}

export function loadFaceApi(): Promise<FaceApi> {
  if (!apiPromise) {
    apiPromise = (async () => {
      const faceapi = (await import("@vladmandic/face-api/dist/face-api.esm.js")) as FaceApi;
      const tf = faceapi.tf as unknown as {
        setBackend: (name: string) => Promise<boolean>;
        ready: () => Promise<void>;
      };
      await tf.setBackend("webgl").catch(() => tf.setBackend("cpu"));
      await tf.ready();

      // TinyFaceDetector (190KB) drives the real-time 30-60 FPS tracking HUD.
      // SsdMobilenetv1 (5.4MB) is slower but locates and aligns the face far more
      // precisely, so it is used whenever a descriptor is extracted for matching.
      // Plus FaceLandmark68Net (356KB) and FaceRecognitionNet (6.4MB).
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri("/models"),
        faceapi.nets.ssdMobilenetv1.loadFromUri("/models"),
        faceapi.nets.faceLandmark68Net.loadFromUri("/models"),
        faceapi.nets.faceRecognitionNet.loadFromUri("/models"),
      ]);

      await warmUp(faceapi);
      modelsLoaded = true;
      return faceapi;
    })().catch((err) => {
      apiPromise = null;
      modelsLoaded = false;
      throw err;
    });
  }
  return apiPromise;
}

/**
 * Runs every network once on a blank image so WebGL compiles its shaders now,
 * in the background, instead of during the voter's first scan (~0.5 s saved).
 */
async function warmUp(faceapi: FaceApi) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 160;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#8a7a6a";
      ctx.fillRect(0, 0, 160, 160);
    }
    await faceapi.detectAllFaces(canvas, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }));
    await faceapi.detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 320 }));
    await faceapi.nets.faceLandmark68Net.detectLandmarks(canvas);
    await faceapi.nets.faceRecognitionNet.computeFaceDescriptor(canvas);
  } catch {
    // Warm-up is only an optimisation.
  }
}

/** Eye aspect ratio (both eyes averaged) from the 68 landmarks: drops sharply when the eyes close. */
export function eyeAspectRatio(landmarks: Array<{ x: number; y: number }>): number {
  const dist = (p1: { x: number; y: number }, p2: { x: number; y: number }) => Math.hypot(p1.x - p2.x, p1.y - p2.y);
  const left =
    (dist(landmarks[37], landmarks[41]) + dist(landmarks[38], landmarks[40])) / (2 * Math.max(1, dist(landmarks[36], landmarks[39])));
  const right =
    (dist(landmarks[43], landmarks[47]) + dist(landmarks[44], landmarks[46])) / (2 * Math.max(1, dist(landmarks[42], landmarks[45])));
  return (left + right) / 2;
}

export type PoseEstimate = {
  yaw: number; // in degrees: negative = turned right, positive = turned left
  pitch: number; // in degrees: negative = looking up, positive = looking down
  roll: number; // in degrees: head tilt
  symmetryRatio: number; // ~1.0 when perfectly front
  isFullyFrontal: boolean;
  poseFeedback: string;
};

/**
 * Strict 3D Head Pose and Frontality estimation using 68 facial landmarks.
 * Accurately detects whether the user is facing fully front or turned to the sides.
 */
export function estimatePoseFromLandmarks(
  landmarks: Array<{ x: number; y: number }>
): PoseEstimate {
  if (!landmarks || landmarks.length < 68) {
    return {
      yaw: 0,
      pitch: 0,
      roll: 0,
      symmetryRatio: 1,
      isFullyFrontal: false,
      poseFeedback: "Looking for face…",
    };
  }

  // Right eye center (subject's right eye, camera image left: points 36..41)
  const rx = (landmarks[36].x + landmarks[39].x) / 2;
  const ry = (landmarks[36].y + landmarks[39].y) / 2;

  // Left eye center (subject's left eye, camera image right: points 42..47)
  const lx = (landmarks[42].x + landmarks[45].x) / 2;
  const ly = (landmarks[42].y + landmarks[45].y) / 2;

  const eyeMidX = (rx + lx) / 2;
  const ipd = Math.max(1, Math.hypot(lx - rx, ly - ry));

  // Roll (head tilt in degrees)
  const rollDegrees = Math.round(Math.atan2(ly - ry, lx - rx) * (180 / Math.PI));

  // Nose tip (point 30)
  const noseTip = landmarks[30];

  // Distances from nose tip to both eye centers
  const distR = Math.hypot(noseTip.x - rx, noseTip.y - ry);
  const distL = Math.hypot(noseTip.x - lx, noseTip.y - ly);
  const symmetryRatio = Math.round((Math.min(distR, distL) / Math.max(distR, distL, 1)) * 100) / 100;

  // Normalized lateral nose displacement from eye center line
  const noseOffsetRatio = (noseTip.x - eyeMidX) / ipd;
  const yawDegrees = Math.round(noseOffsetRatio * 95);

  // Pitch (nose length relative to eye-to-chin distance)
  const noseBridge = landmarks[27];
  const chin = landmarks[8];
  const faceHeight = Math.max(1, chin.y - noseBridge.y);
  const pitchRatio = (noseTip.y - noseBridge.y) / faceHeight;
  const pitchDegrees = Math.round((pitchRatio - 0.42) * 90);

  // Frontal criteria (tuned so ordinary laptop / phone cameras pass):
  // - Yaw within +/- 10 degrees (no looking to sides)
  // - Roll within +/- 10 degrees (no head tilting)
  // - Pitch within +/- 12 degrees (looking level at camera)
  // - Eye-to-nose symmetry >= 0.80 (both sides of face equidistant)
  const isYawFrontal = Math.abs(yawDegrees) <= 10;
  const isRollFrontal = Math.abs(rollDegrees) <= 10;
  const isPitchFrontal = Math.abs(pitchDegrees) <= 12;
  const isSymmetryFrontal = symmetryRatio >= 0.8;

  const isFullyFrontal = isYawFrontal && isRollFrontal && isPitchFrontal && isSymmetryFrontal;

  let poseFeedback = "Facing fully front ✓";
  if (yawDegrees > 10) {
    poseFeedback = "Turn head slightly to your LEFT (face front)";
  } else if (yawDegrees < -10) {
    poseFeedback = "Turn head slightly to your RIGHT (face front)";
  } else if (Math.abs(rollDegrees) > 10) {
    poseFeedback = "Straighten head tilt (hold level)";
  } else if (pitchDegrees > 12) {
    poseFeedback = "Raise head slightly (look straight ahead)";
  } else if (pitchDegrees < -12) {
    poseFeedback = "Lower head slightly (look into lens)";
  } else if (!isSymmetryFrontal) {
    poseFeedback = "Face camera directly (align center)";
  }

  return {
    yaw: yawDegrees,
    pitch: pitchDegrees,
    roll: rollDegrees,
    symmetryRatio,
    isFullyFrontal,
    poseFeedback,
  };
}

export type BiometricTelemetry = {
  faceFound: boolean;
  multipleFaces: boolean;
  score: number;
  box: { x: number; y: number; width: number; height: number };
  landmarks: Array<{ x: number; y: number }>;
  yaw: number; // in degrees: negative = turned right, positive = turned left
  pitch: number; // in degrees: negative = looking up, positive = looking down
  roll: number; // in degrees: head tilt
  symmetryRatio: number; // ~1.0 when perfectly front
  isFullyFrontal: boolean; // TRUE only when strictly facing front (not sides)
  poseFeedback: string;
  isCentered: boolean;
  distanceStatus: "TOO_FAR" | "TOO_CLOSE" | "OPTIMAL";
  lightingStatus: "TOO_DARK" | "TOO_BRIGHT" | "GOOD";
  isBlinking: boolean;
  /** Eye aspect ratio (average of both eyes): drops sharply when the eyes close. */
  ear: number;
};

/**
 * Ultra-fast live frame analysis (~15ms per frame) for real-time HUD rendering.
 */
export async function analyzeLiveFrame(
  video: HTMLVideoElement,
  faceapi: FaceApi
): Promise<BiometricTelemetry | null> {
  if (video.readyState < 2 || video.paused || video.ended) return null;

  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;

  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
  const allDetections = await faceapi.detectAllFaces(video, options).withFaceLandmarks();

  if (allDetections.length === 0) {
    return {
      faceFound: false,
      multipleFaces: false,
      score: 0,
      box: { x: 0, y: 0, width: 0, height: 0 },
      landmarks: [],
      yaw: 0,
      pitch: 0,
      roll: 0,
      symmetryRatio: 1,
      isFullyFrontal: false,
      poseFeedback: "Looking for face…",
      isCentered: false,
      distanceStatus: "TOO_FAR",
      lightingStatus: "GOOD",
      isBlinking: false,
      ear: 0,
    };
  }

  if (allDetections.length > 1) {
    const primary = allDetections[0];
    const pose = estimatePoseFromLandmarks(primary.landmarks.positions);
    return {
      faceFound: true,
      multipleFaces: true,
      score: primary.detection.score,
      box: primary.detection.box,
      landmarks: primary.landmarks.positions,
      yaw: pose.yaw,
      pitch: pose.pitch,
      roll: pose.roll,
      symmetryRatio: pose.symmetryRatio,
      isFullyFrontal: false,
      poseFeedback: "Multiple faces detected — ensure 1 person only",
      isCentered: false,
      distanceStatus: "OPTIMAL",
      lightingStatus: "GOOD",
      isBlinking: false,
      ear: 0,
    };
  }

  const detection = allDetections[0];
  const box = detection.detection.box;
  const landmarks = detection.landmarks.positions;

  // 1. Strict head pose & frontality
  const pose = estimatePoseFromLandmarks(landmarks);

  // 2. Centering & Distance estimation
  const boxCenterX = box.x + box.width / 2;
  const boxCenterY = box.y + box.height / 2;
  const isCentered =
    Math.abs(boxCenterX - vw / 2) < vw * 0.2 && Math.abs(boxCenterY - vh / 2) < vh * 0.25;

  const widthRatio = box.width / vw;
  let distanceStatus: "TOO_FAR" | "TOO_CLOSE" | "OPTIMAL" = "OPTIMAL";
  if (widthRatio < 0.2) distanceStatus = "TOO_FAR";
  else if (widthRatio > 0.75) distanceStatus = "TOO_CLOSE";

  // 3. Eye Aspect Ratio (EAR) for blink detection
  const avgEAR = eyeAspectRatio(landmarks);
  const isBlinking = avgEAR < 0.16;

  return {
    faceFound: true,
    multipleFaces: false,
    score: detection.detection.score,
    box: { x: box.x, y: box.y, width: box.width, height: box.height },
    landmarks,
    yaw: pose.yaw,
    pitch: pose.pitch,
    roll: pose.roll,
    symmetryRatio: pose.symmetryRatio,
    isFullyFrontal: pose.isFullyFrontal,
    poseFeedback: pose.poseFeedback,
    isCentered,
    distanceStatus,
    lightingStatus: "GOOD",
    isBlinking,
    ear: Math.round(avgEAR * 1000) / 1000,
  };
}

/**
 * Extracts the 128-d descriptor using FaceRecognitionNet on a single face.
 * If requireFrontal is true, returns null if face is turned to the side.
 */
export async function computeDescriptorFromVideo(
  video: HTMLVideoElement,
  faceapi: FaceApi,
  requireFrontal = false
): Promise<Float32Array | null> {
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 });
  const result = await faceapi
    .detectSingleFace(video, options)
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!result) return null;

  if (requireFrontal) {
    const pose = estimatePoseFromLandmarks(result.landmarks.positions);
    if (!pose.isFullyFrontal) {
      return null;
    }
  }

  return result.descriptor;
}

/**
 * Extracts a high-res, centered square portrait photo of the face for voter credentials.
 * Supports flexible calling conventions:
 *   cropFaceSnapshot(video, box)
 *   cropFaceSnapshot(video, fallbackCanvas, box)
 */
/**
 * Extracts a high-res, centered square portrait photo of the face for voter credentials.
 * Uses a double-buffered 2D canvas pipeline from the live video feed:
 * 1. Blits the raw video frame 1:1 onto an unscaled memory canvas.
 * 2. Crops the verified face region with generous portrait margins (or center-crops).
 * 3. Mirrors horizontally to preserve the selfie perspective.
 * 4. Exports high-quality JPEG base64 data URL.
 */
export async function cropFaceSnapshot(
  video: HTMLVideoElement,
  arg2?: { x: number; y: number; width: number; height: number } | HTMLCanvasElement | null,
  arg3?: { x: number; y: number; width: number; height: number } | null
): Promise<string> {
  try {
    let box: { x: number; y: number; width: number; height: number } | null = null;

    if (arg2) {
      if (typeof (arg2 as HTMLCanvasElement).getContext === "function") {
        // arg2 is an HTMLCanvasElement (e.g. HUD overlay canvas).
        // Never draw pixels from the HUD overlay canvas — use arg3 as the bounding box.
        box = arg3 ?? null;
      } else {
        box = arg2 as { x: number; y: number; width: number; height: number };
      }
    }

    // Ensure video element has active dimensions and frame data
    for (let i = 0; i < 8 && (video.readyState < 2 || !video.videoWidth || !video.videoHeight); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }

    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;

    // Stage 1: Full-resolution intermediate snapshot from raw video feed
    const fullCanvas = document.createElement("canvas");
    fullCanvas.width = vw;
    fullCanvas.height = vh;
    const fullCtx = fullCanvas.getContext("2d", { willReadFrequently: true });
    if (!fullCtx) return "";

    // Direct 1:1 hardware blit from video to 2D memory surface
    fullCtx.drawImage(video, 0, 0, vw, vh);

    // Verify raw frame buffer contains pixel data; flush 1 frame if needed
    try {
      const sample = fullCtx.getImageData(
        Math.max(0, Math.floor(vw / 2) - 10),
        Math.max(0, Math.floor(vh / 2) - 10),
        20,
        20
      );
      let hasColor = false;
      for (let i = 0; i < sample.data.length; i += 4) {
        if (
          sample.data[i + 3] > 0 &&
          (sample.data[i] > 5 || sample.data[i + 1] > 5 || sample.data[i + 2] > 5)
        ) {
          hasColor = true;
          break;
        }
      }
      if (!hasColor) {
        await new Promise((r) => requestAnimationFrame(r));
        fullCtx.drawImage(video, 0, 0, vw, vh);
      }
    } catch {
      // Ignore cross-origin context taint if any
    }

    // Stage 2: Calculate crop bounding box
    let sx = 0;
    let sy = 0;
    let sw = vw;
    let sh = vh;

    if (box && typeof box.width === "number" && box.width > 20 && box.height > 20) {
      // Generous portrait framing (38% lateral margin, 45% forehead/hair margin, 55% neck/chin margin)
      const padX = box.width * 0.38;
      const padYTop = box.height * 0.45;
      const padYBottom = box.height * 0.55;

      const rawLeft = Math.max(0, box.x - padX);
      const rawTop = Math.max(0, box.y - padYTop);
      const rawRight = Math.min(vw, box.x + box.width + padX);
      const rawBottom = Math.min(vh, box.y + box.height + padYBottom);

      const rawW = rawRight - rawLeft;
      const rawH = rawBottom - rawTop;
      const side = Math.max(rawW, rawH);

      const cx = (rawLeft + rawRight) / 2;
      const cy = (rawTop + rawBottom) / 2;

      sx = Math.max(0, Math.min(Math.floor(cx - side / 2), vw - side));
      sy = Math.max(0, Math.min(Math.floor(cy - side / 2), vh - side));
      sw = Math.max(20, Math.min(Math.floor(side), vw - sx));
      sh = Math.max(20, Math.min(Math.floor(side), vh - sy));
    } else {
      // Center-crop square portrait
      const side = Math.min(vw, vh);
      sx = Math.floor((vw - side) / 2);
      sy = Math.floor((vh - side) / 2);
      sw = side;
      sh = side;
    }

    // Stage 3: Render square portrait onto 320x320 canvas with selfie mirror
    const size = 320;
    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = size;
    cropCanvas.height = size;
    const cropCtx = cropCanvas.getContext("2d");
    if (!cropCtx) return "";

    // Fill neutral slate background
    cropCtx.fillStyle = "#0f172a";
    cropCtx.fillRect(0, 0, size, size);

    // Draw horizontally mirrored so portrait matches user's selfie view
    cropCtx.save();
    cropCtx.translate(size, 0);
    cropCtx.scale(-1, 1);
    cropCtx.drawImage(fullCanvas, sx, sy, sw, sh, 0, 0, size, size);
    cropCtx.restore();

    return cropCanvas.toDataURL("image/jpeg", 0.92);
  } catch (err) {
    console.error("cropFaceSnapshot error:", err);
    return "";
  }
}

/** Synthesize premium audio feedback for biometric scanning using Web Audio API. */
export function playBiometricSound(type: "step" | "success" | "error"): void {
  try {
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const now = ctx.currentTime;

    if (type === "step") {
      // Soft gentle tone for step transition
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(659.25, now); // E5
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.12);
    } else if (type === "success") {
      // Harmonious major triad chime: C5 -> E5 -> G5
      [523.25, 659.25, 783.99].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        const start = now + idx * 0.08;
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.08, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.35);
      });
    } else if (type === "error") {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(220, now);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.2);
    }
  } catch {
    // Audio context not allowed or not supported; ignore gracefully
  }
}

/** Average several descriptors into one, which is more stable than a single frame. */
export function averageDescriptors(list: Float32Array[]): number[] {
  if (list.length === 0) return [];
  const out = new Array<number>(list[0].length).fill(0);
  for (const d of list) {
    for (let i = 0; i < d.length; i++) out[i] += d[i] / list.length;
  }
  return out;
}

export function cameraSupportError(): string | null {
  if (typeof window === "undefined") return null;
  if (!window.isSecureContext) {
    return "Camera access needs a secure connection. Open this page via https:// or http://localhost.";
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return "This browser does not support camera access.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// High-accuracy capture: several quality-checked frames, fused into one template
// ---------------------------------------------------------------------------

type Box = { x: number; y: number; width: number; height: number };

export type FaceSample = { descriptor: Float32Array; box: Box; score: number };

export type QualityIssue =
  | "NO_FACE"
  | "MULTIPLE_FACES"
  | "LOW_CONFIDENCE"
  | "TOO_SMALL"
  | "NOT_FRONTAL"
  | "TOO_DARK"
  | "TOO_BRIGHT"
  | "BLURRY"
  | "EYES_CLOSED";

export const QUALITY_HINTS: Record<QualityIssue, string> = {
  NO_FACE: "Looking for your face…",
  MULTIPLE_FACES: "Only one person may be in the frame",
  LOW_CONFIDENCE: "Face not clear — remove glasses, hats or masks",
  TOO_SMALL: "Move a little closer to the camera",
  NOT_FRONTAL: "Look straight into the camera",
  TOO_DARK: "Too dark — face a window or a light",
  TOO_BRIGHT: "Too bright — move away from the strong light",
  BLURRY: "Hold still — the image is blurry",
  EYES_CLOSED: "Keep your eyes open and look at the camera",
};

/** Below this eye aspect ratio the eyes are (nearly) closed: such frames make a poorer face template. */
const EYES_OPEN_MIN_EAR = 0.17;

/** Brightness (0-255) and sharpness (variance of the Laplacian) of the face area. */
function faceImageStats(video: HTMLVideoElement, box: Box): { brightness: number; sharpness: number } {
  const size = 96;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { brightness: 128, sharpness: 100 };
  ctx.drawImage(video, box.x, box.y, box.width, box.height, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);

  const gray = new Float32Array(size * size);
  let sum = 0;
  for (let i = 0; i < gray.length; i++) {
    const g = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    gray[i] = g;
    sum += g;
  }

  let lapSum = 0;
  let lapSq = 0;
  let n = 0;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x;
      const lap = gray[i - 1] + gray[i + 1] + gray[i - size] + gray[i + size] - 4 * gray[i];
      lapSum += lap;
      lapSq += lap * lap;
      n++;
    }
  }
  const mean = lapSum / n;
  return { brightness: sum / gray.length, sharpness: lapSq / n - mean * mean };
}

/**
 * One high-quality reading: precise SSD detector, exactly one face, frontal,
 * large enough, well lit and sharp. Otherwise returns why it was rejected.
 */
export async function captureQualitySample(
  video: HTMLVideoElement,
  faceapi: FaceApi
): Promise<{ sample?: FaceSample; issue?: QualityIssue }> {
  if (video.readyState < 2) return { issue: "NO_FACE" };
  const options = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5, maxResults: 3 });
  const results = await faceapi.detectAllFaces(video, options).withFaceLandmarks().withFaceDescriptors();

  if (results.length === 0) return { issue: "NO_FACE" };
  if (results.length > 1) return { issue: "MULTIPLE_FACES" };

  const r = results[0];
  const b = r.detection.box;
  const box = { x: b.x, y: b.y, width: b.width, height: b.height };
  if (r.detection.score < 0.8) return { issue: "LOW_CONFIDENCE" };
  if (box.width / (video.videoWidth || 640) < 0.16) return { issue: "TOO_SMALL" };
  if (!estimatePoseFromLandmarks(r.landmarks.positions).isFullyFrontal) return { issue: "NOT_FRONTAL" };
  if (eyeAspectRatio(r.landmarks.positions) < EYES_OPEN_MIN_EAR) return { issue: "EYES_CLOSED" };

  const { brightness, sharpness } = faceImageStats(video, box);
  if (brightness < 45) return { issue: "TOO_DARK" };
  if (brightness > 215) return { issue: "TOO_BRIGHT" };
  if (sharpness < 18) return { issue: "BLURRY" };

  return { sample: { descriptor: r.descriptor, box, score: r.detection.score } };
}

/** Collects `count` good readings (or gives up after `timeoutMs`). */
export async function collectFaceSamples(
  video: HTMLVideoElement,
  faceapi: FaceApi,
  {
    count = 5,
    timeoutMs = 6000,
    onProgress,
  }: { count?: number; timeoutMs?: number; onProgress?: (got: number, issue?: QualityIssue) => void } = {}
): Promise<FaceSample[]> {
  const samples: FaceSample[] = [];
  const deadline = performance.now() + timeoutMs;
  while (samples.length < count && performance.now() < deadline) {
    const { sample, issue } = await captureQualitySample(video, faceapi);
    if (sample) samples.push(sample);
    onProgress?.(samples.length, issue);
    // Each reading already takes a few hundred ms, which spreads them over natural micro-movements.
    await new Promise((r) => setTimeout(r, 40));
  }
  return samples;
}

/**
 * Fuses readings into one template: drops outliers (a blink, a half-turn)
 * that sit far from the rest, then averages what remains.
 */
export function fuseDescriptors(list: Float32Array[]): { mean: number[]; kept: number[][] } {
  const mean0 = averageDescriptors(list);
  if (list.length <= 2) return { mean: mean0, kept: list.map((d) => Array.from(d)) };

  const dists = list.map((d) => faceDistance(d, mean0));
  const sorted = [...dists].sort((a, z) => a - z);
  const median = sorted[Math.floor(sorted.length / 2)];
  const limit = Math.max(0.2, median * 1.6);
  const kept = list.filter((_, i) => dists[i] <= limit);
  return { mean: averageDescriptors(kept), kept: kept.map((d) => Array.from(d)) };
}
