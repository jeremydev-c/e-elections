/**
 * Accuracy and speed of the server face engine on LFW ("Labeled Faces in the Wild"), the
 * standard face-verification test: 6,000 photo pairs (3,000 same person, 3,000 different),
 * scored with the official 10-fold protocol. Also reports how many impostor pairs pass at
 * the thresholds E-ELECTIONS uses.
 *
 * Data (not in the repo): lfw.tgz and pairs.txt, e.g. from scikit-learn's mirror
 *   https://ndownloader.figshare.com/files/5976018 (lfw.tgz) and /files/5976006 (pairs.txt)
 *
 * Run:  LFW_DIR=path/to/folder-with-lfw-and-pairs.txt npx tsx scripts/benchmark-lfw.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { alignFace, cosine, decodeImage, detectFaces, embedAligned, sessions } from "../src/lib/faceEngine";
import { FACE_MATCH_MIN } from "../src/lib/faceMath";

const DIR = process.env.LFW_DIR || "lfw-data";

type Pair = { a: string; b: string; same: boolean; fold: number };

function readPairs(): Pair[] {
  const lines = readFileSync(path.join(DIR, "pairs.txt"), "utf8").trim().split(/\r?\n/);
  const [folds, n] = lines[0].split(/\s+/).map(Number);
  const file = (name: string, i: string) => path.join(DIR, "lfw", name, `${name}_${i.padStart(4, "0")}.jpg`);
  const pairs: Pair[] = [];
  lines.slice(1).forEach((line, k) => {
    const p = line.trim().split(/\s+/);
    const fold = Math.floor(k / (2 * n));
    if (p.length === 3) pairs.push({ a: file(p[0], p[1]), b: file(p[0], p[2]), same: true, fold });
    else pairs.push({ a: file(p[0], p[1]), b: file(p[2], p[3]), same: false, fold });
  });
  if (pairs.length !== folds * 2 * n) throw new Error("pairs.txt not read correctly");
  return pairs;
}

async function main() {
  await sessions();
  const pairs = readPairs();
  const files = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
  const emb = new Map<string, number[]>();
  let noFace = 0;
  const times: number[] = [];
  for (let i = 0; i < files.length; i++) {
    const img = await decodeImage(readFileSync(files[i]));
    const t = performance.now();
    const faces = await detectFaces(img, 0.3);
    // LFW photos are centred on the person: take the face nearest the centre.
    const c = [img.width / 2, img.height / 2];
    const face = faces.sort(
      (x, y) =>
        Math.hypot((x.box[0] + x.box[2]) / 2 - c[0], (x.box[1] + x.box[3]) / 2 - c[1]) -
        Math.hypot((y.box[0] + y.box[2]) / 2 - c[0], (y.box[1] + y.box[3]) / 2 - c[1])
    )[0];
    if (!face) {
      noFace++;
      continue;
    }
    emb.set(files[i], (await embedAligned([alignFace(img, face)]))[0]);
    times.push(performance.now() - t);
    if (i % 500 === 0) console.log(`${i}/${files.length} images`);
  }

  // A pair with an undetected face counts as a failed comparison (similarity -1).
  const scored = pairs.map((p) => ({ ...p, sim: emb.has(p.a) && emb.has(p.b) ? cosine(emb.get(p.a)!, emb.get(p.b)!) : -1 }));
  const acc = (list: typeof scored, th: number) => list.filter((p) => (p.sim >= th) === p.same).length / list.length;

  // Official protocol: choose the threshold on 9 folds, test on the 10th.
  const foldAcc: number[] = [];
  const thresholds: number[] = [];
  for (let f = 0; f < 10; f++) {
    const train = scored.filter((p) => p.fold !== f);
    let best = 0, bestTh = 0;
    for (let th = -0.2; th <= 0.9; th += 0.005) {
      const a = acc(train, th);
      if (a > best) [best, bestTh] = [a, th];
    }
    thresholds.push(bestTh);
    foldAcc.push(acc(scored.filter((p) => p.fold === f), bestTh));
  }
  const mean = foldAcc.reduce((a, b) => a + b) / 10;
  const sd = Math.sqrt(foldAcc.reduce((a, b) => a + (b - mean) ** 2, 0) / 10);

  const same = scored.filter((p) => p.same).map((p) => p.sim).sort((a, b) => a - b);
  const diff = scored.filter((p) => !p.same).map((p) => p.sim).sort((a, b) => a - b);
  const at = (th: number) => ({
    threshold: th,
    trueAccept: Math.round((same.filter((s) => s >= th).length / same.length) * 10000) / 100,
    falseAccepts: diff.filter((s) => s >= th).length,
    impostorPairs: diff.length,
  });
  times.sort((a, b) => a - b);
  const result = {
    date: new Date().toISOString(),
    model: "SCRFD-10GF @320 + 5-point alignment + ArcFace R50 (WebFace600K)",
    images: files.length,
    noFaceFound: noFace,
    accuracy10fold: Math.round(mean * 10000) / 100,
    accuracyStdDev: Math.round(sd * 10000) / 100,
    meanBestThreshold: Math.round((thresholds.reduce((a, b) => a + b) / 10) * 1000) / 1000,
    highestImpostorSimilarity: Math.round(diff[diff.length - 1] * 1000) / 1000,
    lowestGenuineSimilarity: Math.round(same[0] * 1000) / 1000,
    atAppThreshold: at(FACE_MATCH_MIN),
    atZeroFalseAccepts: at(Math.ceil(diff[diff.length - 1] * 1000) / 1000 + 0.001),
    msPerImage: { median: Math.round(times[Math.floor(times.length / 2)]), p95: Math.round(times[Math.floor(times.length * 0.95)]) },
  };
  console.log(JSON.stringify(result, null, 1));
  writeFileSync(path.join("scripts", "lfw-results.json"), JSON.stringify(result, null, 1) + "\n");
}

main().then(() => process.exit(0));
