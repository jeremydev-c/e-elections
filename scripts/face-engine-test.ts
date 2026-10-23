/**
 * Tests the server face engine and scan checks on REAL face photos (needs the models from
 * scripts/fetch-face-models.ts and the LFW photos used by scripts/benchmark-lfw.ts):
 *   LFW_DIR=path/to/lfw-folder npx tsx scripts/face-engine-test.ts
 *
 * Every way a scan must be refused is tried: wrong frames, no face, two people, too dark,
 * too far, someone swapped in mid-scan, moves not done. Then real matching: the same person
 * on a different photo is accepted, a different person is not. Last, the voter-card photo:
 * the head-pose measure and the passport-style crop.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { faceModelsInstalled } from "../src/lib/faceEngine";
import { SCAN, analyseCardPhoto, analyseScan, headPose, type ScanFrame, type ScanResult } from "../src/lib/faceScan";
import { FACE_MATCH_MIN, meanEmbedding, templateSimilarity } from "../src/lib/faceMath";
import type { LivenessStep } from "../src/lib/liveness";

const DIR = process.env.LFW_DIR || "lfw-data";
let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
  if (!ok) failed++;
};

const photo = (name: string, n: number) => readFileSync(path.join(DIR, "lfw", name, `${name}_${String(n).padStart(4, "0")}.jpg`));
const jpeg = async (s: ReturnType<typeof sharp>) => `data:image/jpeg;base64,${(await s.jpeg({ quality: 90 }).toBuffer()).toString("base64")}`;
/** LFW photos are 250 px; scale to a phone-camera-like 500 px. */
const frame = (buf: Buffer) => jpeg(sharp(buf).resize(500, 500));
const frames = (roles: ScanFrame["role"][], images: string[]): ScanFrame[] => roles.map((role, i) => ({ role, image: images[i] }));
const problem = (r: ScanResult) => (r.ok ? "accepted" : `${r.problem}: ${r.detail}`);

async function main() {
  if (!faceModelsInstalled() || !existsSync(path.join(DIR, "lfw"))) {
    console.log("SKIPPED: needs ml-models/ (scripts/fetch-face-models.ts) and LFW_DIR with the LFW photos.");
    return;
  }
  const A = "Kofi_Annan";
  const B = "Serena_Williams";
  const a = await Promise.all([1, 2, 3, 4, 5].map((n) => frame(photo(A, n))));
  const b = await Promise.all([1, 2].map((n) => frame(photo(B, n))));
  const steps: LivenessStep[] = ["TURN_LEFT", "BLINK", "TURN_RIGHT"];
  const roles: ScanFrame["role"][] = ["FRONT", "FRONT", "FRONT", ...steps];
  const scan = (imgs: string[], s = steps) => analyseScan(frames(["FRONT", "FRONT", "FRONT", ...s], imgs), s);

  // Malformed scans.
  check("Too few frames refused", problem(await analyseScan(frames(["FRONT", "FRONT"], a), steps)).startsWith("BAD_FRAMES"));
  check("Frames out of the challenge's order refused",
    problem(await analyseScan(frames(["FRONT", "FRONT", "FRONT", "BLINK", "TURN_LEFT", "TURN_RIGHT"], [...a, a[0]]), steps)).startsWith("BAD_FRAMES"));
  check("Non-image frame refused", problem(await analyseScan(frames(roles, ["data:text/html;base64,PGgxPg==", ...a.slice(1), a[0]]), steps)).startsWith("BAD_FRAMES"));

  // Picture problems.
  const grey = await jpeg(sharp({ create: { width: 500, height: 500, channels: 3, background: { r: 120, g: 120, b: 120 } } }));
  check("Empty picture: no face", problem(await scan([grey, a[1], a[2], a[0], a[0], a[0]])).startsWith("NO_FACE"));
  const dark = await jpeg(sharp(photo(A, 1)).resize(500, 500).linear(0.12, 0));
  const r1 = await scan([dark, a[1], a[2], a[0], a[0], a[0]]);
  check("Very dark picture refused", /^(TOO_DARK|NO_FACE)/.test(problem(r1)), problem(r1));
  const far = await jpeg(sharp(photo(A, 1)).resize(110, 110).extend({ top: 300, bottom: 300, left: 300, right: 300, background: "#777" }));
  const r2 = await scan([far, a[1], a[2], a[0], a[0], a[0]]);
  check("Face too far from the camera refused", /^(TOO_SMALL|NO_FACE)/.test(problem(r2)), problem(r2));
  const two = await jpeg(
    sharp({ create: { width: 1000, height: 500, channels: 3, background: "#777" } }).composite([
      { input: await sharp(photo(A, 1)).resize(500, 500).toBuffer(), left: 0, top: 0 },
      { input: await sharp(photo(B, 1)).resize(500, 500).toBuffer(), left: 500, top: 0 },
    ])
  );
  check("Two people in the picture refused", problem(await scan([two, a[1], a[2], a[0], a[0], a[0]])).startsWith("MULTIPLE_FACES"));

  // Liveness and identity.
  const r3 = await scan([a[0], a[1], a[2], a[0], a[0], a[0]]);
  check("Head not turned for TURN_LEFT refused", problem(r3).startsWith("MOVE_NOT_DONE: TURN_LEFT"), problem(r3));
  const r4 = await scan([a[0], a[1], a[2], a[0], a[0], a[0]], ["BLINK", "TURN_LEFT", "TURN_RIGHT"]);
  check("Eyes open for BLINK refused", problem(r4).startsWith("MOVE_NOT_DONE: BLINK"), problem(r4));
  const r5 = await scan([a[0], a[1], b[0], a[0], a[0], a[0]]);
  check("Someone else swapped into the scan refused", problem(r5).startsWith("DIFFERENT_PEOPLE"), problem(r5));
  const mirror = await jpeg(sharp(photo(A, 1)).resize(500, 500).flop());
  const r6 = await scan([a[0], a[1], a[2], mirror, a[0], a[0]]);
  check("Mirrored photo is not a head turn", problem(r6).startsWith("MOVE_NOT_DONE"), problem(r6));

  // Real matching (the identity vectors the scan would produce for its frontal frames).
  const { embedAligned, alignFace, decodeImage, detectFaces } = await import("../src/lib/faceEngine");
  const vec = async (buf: Buffer) => {
    const img = await decodeImage(await sharp(buf).resize(500, 500).jpeg().toBuffer());
    return (await embedAligned([alignFace(img, (await detectFaces(img))[0])]))[0];
  };
  const enrolled = await Promise.all([1, 2, 3].map((n) => vec(photo(A, n))));
  const template = { mean: meanEmbedding(enrolled), samples: enrolled };
  const sameNew = templateSimilarity(template, await vec(photo(A, 6)));
  const other = templateSimilarity(template, await vec(photo(B, 3)));
  check("Same person, different photo and day: accepted", sameNew >= FACE_MATCH_MIN, `similarity ${sameNew.toFixed(3)}`);
  check("Different person: refused", other < FACE_MATCH_MIN, `similarity ${other.toFixed(3)}`);

  // Voter-card photo. Synthetic keypoints: eyes, nose tip, mouth corners of a straight face.
  const { portraitCrop } = await import("../src/lib/faceEngine");
  type Kps = [number, number][];
  const straight: Kps = [[80, 100], [120, 100], [100, 122], [84, 140], [116, 140]];
  const tipped: Kps = straight.map(([x, y], i) => [x, i === 2 ? 112 : y]);
  const rot = (k: Kps, deg: number): Kps => {
    const t = (deg * Math.PI) / 180;
    return k.map(([x, y]) => [100 + (x - 100) * Math.cos(t) - (y - 120) * Math.sin(t), 120 + (x - 100) * Math.sin(t) + (y - 120) * Math.cos(t)]);
  };
  const face = (kps: Kps) => ({ box: [0, 0, 200, 200] as [number, number, number, number], score: 1, kps });
  const ok = (k: Kps) => {
    const p = headPose(face(k));
    return Math.abs(p.yaw) <= SCAN.PHOTO_MAX_YAW && Math.abs(p.pitch - SCAN.PHOTO_PITCH) <= SCAN.PHOTO_PITCH_TOL;
  };
  check("Card photo: a straight face passes", ok(straight), `pitch ${headPose(face(straight)).pitch.toFixed(2)}`);
  check("Card photo: head tipped back is refused", !ok(tipped), `pitch ${headPose(face(tipped)).pitch.toFixed(2)}`);
  check("Card photo: a tilted head is not mistaken for tipped", ok(rot(straight, 18)), `pitch ${headPose(face(rot(straight, 18))).pitch.toFixed(2)}`);

  const img = await decodeImage(await sharp(photo(A, 1)).resize(500, 500).jpeg().toBuffer());
  const crop = portraitCrop(img, (await detectFaces(img))[0]);
  const again = (await detectFaces(crop))[0];
  const eyeTilt = again ? headPose(again).roll : 99;
  const eyeY = again ? (again.kps[0][1] + again.kps[1][1]) / 2 / crop.height : 0;
  check("Card photo: 300 x 375 crop, eyes level and 47% down", crop.width === 300 && crop.height === 375 && Math.abs(eyeTilt) < 3 && Math.abs(eyeY - 0.47) < 0.03,
    `roll ${eyeTilt.toFixed(1)} deg, eyes at ${(eyeY * 100).toFixed(0)}%`);

  // The card photo taken on its own: straight on, and the same person as the scan.
  const cardOf = (buf: Buffer) => frame(buf).then((img) => analyseCardPhoto(img, template.mean));
  const good = await cardOf(photo(A, 1));
  check("Card photo: straight photo of the voter accepted", good.ok, good.ok ? `yaw ${good.pose.yaw}, pitch ${good.pose.pitch}` : `${good.problem}: ${good.detail}`);
  const turned = await cardOf(photo(A, 14)); // a slight turn (yaw about 0.24), alone in the picture
  check("Card photo: turned photo refused", !turned.ok && turned.problem === "PHOTO_NOT_STRAIGHT", turned.ok ? "accepted" : turned.detail);
  const stranger = await cardOf(photo(B, 1));
  check("Card photo: someone else refused", !stranger.ok && ["PHOTO_NOT_SAME", "PHOTO_NOT_STRAIGHT"].includes(stranger.problem), stranger.ok ? "accepted" : stranger.detail);
}

main().then(() => {
  console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
  process.exit(failed ? 1 : 0);
});
