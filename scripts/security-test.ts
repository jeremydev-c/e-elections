/**
 * Offline security test suite (no database needed):
 *   npx tsx scripts/security-test.ts
 * Covers ledger seals and tamper attacks, biometric encryption, face
 * matching decisions and the CSRF / body-size proxy.
 */
import path from "node:path";
process.loadEnvFile(path.resolve(__dirname, "..", ".env.local"));

import { NextRequest } from "next/server";
import {
  GENESIS_HASH,
  computeBallotHash,
  sealBallot,
  sealHead,
  verifyChain,
  type SealedBallot,
} from "../src/lib/hashChain";
import { decryptFaceTemplate, encryptFaceTemplate } from "../src/lib/biometricVault";
import {
  FACE_MATCH_MIN,
  RIVAL_MARGIN,
  SAME_SCAN_MIN,
  LEARN_MIN,
  MAX_LEARNED,
  cosineSimilarity,
  learnFrame,
  meanEmbedding,
  templateSimilarity,
} from "../src/lib/faceMath";
import { proxy } from "../src/proxy";
import { LIVENESS_STEPS, randomSteps } from "../src/lib/liveness";
import { issueChallenge, redeemChallenge } from "../src/lib/livenessChallenge";
import { FaceIndex } from "../src/lib/faceIndex";

let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
  if (!ok) failed++;
};

// ---------------------------------------------------------------- ledger
function buildChain(n: number) {
  const blocks: SealedBallot[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= n; i++) {
    const b = {
      seq: i,
      receiptCode: `KE-2027-AAAA-000${i}`,
      selections: { PRESIDENT: `p${i % 2}`, MCA: `m${i}` },
      county: "Laikipia",
      timestamp: new Date(1_800_000_000_000 + i * 1000),
      previousHash: prev,
    };
    const currentHash = computeBallotHash(b);
    blocks.push({ ...b, currentHash, seal: sealBallot(currentHash) });
    prev = currentHash;
  }
  return { blocks, head: { seq: n, lastHash: prev, seal: sealHead(n, prev) } };
}
const clone = (bs: SealedBallot[]) => bs.map((b) => ({ ...b, selections: { ...(b.selections as Record<string, string>) } }));
const problems = (a: ReturnType<typeof verifyChain>) => a.issues.map((i) => `${i.problem}#${i.seq}`).join(",");

{
  const { blocks, head } = buildChain(4);
  check("Untouched chain is intact", verifyChain(blocks, head, 4).intact);

  const a1 = clone(blocks);
  (a1[1].selections as Record<string, string>).PRESIDENT = "forged";
  const r1 = verifyChain(a1, head, 4);
  check("Attack 1 (flip vote) detected", !r1.intact && r1.issues.some((i) => i.problem === "HASH_MISMATCH"), problems(r1));

  const a2 = clone(a1);
  a2[1].currentHash = computeBallotHash(a2[1]);
  const r2 = verifyChain(a2, head, 4);
  check("Attack 2 (flip + re-hash) detected", !r2.intact && r2.issues.some((i) => i.problem === "BAD_SEAL"), problems(r2));

  const a3 = clone(a1);
  for (let i = 1; i < a3.length; i++) {
    if (i > 1) a3[i].previousHash = a3[i - 1].currentHash;
    a3[i].currentHash = computeBallotHash(a3[i]);
  }
  const forgedHead = { ...head, lastHash: a3[3].currentHash };
  const r3 = verifyChain(a3, forgedHead, 4);
  const onlySeals = r3.issues.every((i) => i.problem === "BAD_SEAL" || i.problem === "BAD_HEAD_SEAL");
  check("Attack 3 (rewrite whole chain) caught ONLY by HMAC seals", !r3.intact && onlySeals, problems(r3));

  const truncated = blocks.slice(0, 3);
  const rolledBack = { seq: 3, lastHash: truncated[2].currentHash, seal: "00".repeat(32) };
  const r4 = verifyChain(truncated, rolledBack, 4);
  check("Deleting newest ballot + rolling head back detected", !r4.intact, problems(r4));

  const r5 = verifyChain(blocks, head, 5);
  check("Turnout mismatch (stuffed/deleted ballot) detected", r5.issues.some((i) => i.problem === "TURNOUT_MISMATCH"));
}

// ------------------------------------------------------------ encryption
{
  const t = { mean: Array.from({ length: 512 }, (_, i) => Math.sin(i) / 10), samples: [] as number[][] };
  const blob = encryptFaceTemplate(t, "27310001");
  check("Template is not stored in plaintext", !blob.includes("0.0") && blob.startsWith("v1."));
  check("Owner can decrypt their template", decryptFaceTemplate(blob, "27310001")?.mean[5] === t.mean[5]);
  check("Template swapped into another voter fails", decryptFaceTemplate(blob, "27310002") === null);
  const tampered = blob.slice(0, -4) + (blob.endsWith("A") ? "BBBB" : "AAAA");
  check("Tampered ciphertext fails", decryptFaceTemplate(tampered, "27310001") === null);
}

// ---------------------------------------------------------- face matching
// Synthetic 512-number identity vectors that behave like the ArcFace engine: two frames of one
// person ~0.7 alike, a lookalike ~0.55, unrelated people ~0. (Real faces: scripts/benchmark-lfw.ts.)
let vseed = 7;
const vrand = () => ((vseed = (vseed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
const unit = (v: number[]) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
const person = () => unit(Array.from({ length: 512 }, vrand));
const near = (p: number[], noise: number) => unit(p.map((x) => x + vrand() * noise));
{
  const frame = (p: number[]) => near(p, 0.06);
  const enroll = (p: number[]) => {
    const samples = [frame(p), frame(p), frame(p)];
    return { mean: meanEmbedding(samples), samples };
  };
  const scan = (p: number[]) => meanEmbedding([frame(p), frame(p), frame(p)]);

  const alice = person();
  const bob = person();
  const aliceTwin = near(alice, 0.075);
  const tAlice = enroll(alice);
  const tTwin = enroll(aliceTwin);

  const genuine = templateSimilarity(tAlice, scan(alice));
  check("Genuine voter matches", genuine >= FACE_MATCH_MIN, `similarity ${genuine.toFixed(3)}`);

  const impostor = templateSimilarity(tAlice, scan(bob));
  check("Different person rejected", impostor < FACE_MATCH_MIN, `similarity ${impostor.toFixed(3)}`);

  const twinProbe = scan(aliceTwin);
  const twinAsAlice = templateSimilarity(tAlice, twinProbe);
  const twinAsSelf = templateSimilarity(tTwin, twinProbe);
  const caughtByOneToN = twinAsAlice < FACE_MATCH_MIN || twinAsSelf >= Math.max(twinAsAlice - RIVAL_MARGIN, FACE_MATCH_MIN - 0.1);
  check("Lookalike claiming Alice's ID blocked (threshold or 1:N)", caughtByOneToN, `vs Alice ${twinAsAlice.toFixed(3)}, vs self ${twinAsSelf.toFixed(3)}`);

  const mixed = cosineSimilarity(frame(alice), frame(bob));
  check("Frames of two people in one scan are told apart", mixed < SAME_SCAN_MIN, `similarity ${mixed.toFixed(3)}`);
  const same = cosineSimilarity(frame(alice), frame(alice));
  check("Frames of one person agree", same >= SAME_SCAN_MIN, `similarity ${same.toFixed(3)}`);
}

// ------------------------------------------------------------ template learning
{
  const alice = person();
  const frame = (p: number[]) => near(p, 0.06);
  const samples = [frame(alice), frame(alice), frame(alice)];
  let t: { mean: number[]; samples: number[][]; learned?: number[][] } = { mean: meanEmbedding(samples), samples };
  const enrolledMean = t.mean.slice();
  for (let i = 0; i < 10; i++) t = learnFrame(t, frame(alice));
  check("Learned frames are capped", t.learned?.length === MAX_LEARNED, `${t.learned?.length}`);
  check("Learning never moves the registered average", t.mean.every((x, i) => x === enrolledMean[i]));
  // An impostor who somehow got learned frames in still needs the registered face for half the score.
  const bob = person();
  const poisoned = learnFrame(learnFrame(t, frame(bob)), frame(bob));
  const bobScore = templateSimilarity(poisoned, frame(bob));
  check("Poisoned learned frames can't make a stranger pass", bobScore < LEARN_MIN && bobScore < 0.6, `similarity ${bobScore.toFixed(3)}`);
}

// ------------------------------------------------------------------ proxy
{
  const req = (method: string, headers: Record<string, string>) =>
    new NextRequest("http://localhost:3000/api/cast-vote", { method, headers: { host: "localhost:3000", ...headers } });
  const status = (r: Response) => (r.headers.get("x-middleware-next") ? "next" : String(r.status));

  check("Same-origin POST allowed", status(proxy(req("POST", { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }))) === "next");
  check("Cross-site POST blocked (Origin)", status(proxy(req("POST", { origin: "https://evil.example" }))) === "403");
  check("Cross-site POST blocked (Sec-Fetch-Site)", status(proxy(req("POST", { "sec-fetch-site": "cross-site" }))) === "403");
  check("Oversized body rejected", status(proxy(req("POST", { "content-length": "5000000" }))) === "413");
  check("Server-to-server POST (no Origin) allowed", status(proxy(req("POST", {}))) === "next");
  check("GET always allowed", status(proxy(req("GET", { origin: "https://evil.example" }))) === "next");
}

// --------------------------------------------------------------- liveness challenge
// (The moves themselves are checked from real camera frames: scripts/face-engine-test.ts.)
async function livenessTests() {
  const c = await issueChallenge("27310001");
  check("Challenge token redeems once", (await redeemChallenge(c.token, "27310001"))?.join() === c.steps.join());
  check("Replayed challenge token rejected", (await redeemChallenge(c.token, "27310001")) === null);
  const c2 = await issueChallenge("27310001");
  check("Challenge for another ID rejected", (await redeemChallenge(c2.token, "27310002")) === null);
  check("Forged token rejected", (await redeemChallenge(c2.token.slice(0, -4) + "AAAA", "27310001")) === null);

  const seen = new Set<string>();
  for (let i = 0; i < 300; i++) seen.add(randomSteps((max) => Math.floor(Math.random() * max)).join());
  check("All 6 move orders are used", seen.size === 6 && [...seen].every((o) => o.split(",").length === LIVENESS_STEPS.length), `${seen.size} orders`);
}

// ------------------------------------------------------------- face index (1:N)
{
  const faces = Array.from({ length: 3000 }, person);
  const index = new FaceIndex();
  faces.forEach((f, i) => index.add(`v${i}`, f));
  check("Index holds every voter (no 5,000-style cap, grows past its first block)", index.size === 3000, `${index.size}`);

  // The index stores 8-bit numbers (a quarter of the memory); compare with exact 32-bit cosine ranking.
  let sameBest = 0;
  let overlap = 0;
  for (let q = 0; q < 25; q++) {
    const probe = near(faces[q * 37], 0.06);
    const exact = faces
      .map((f, i) => ({ id: `v${i}`, s: cosineSimilarity(f, probe) }))
      .sort((x, y) => y.s - x.s)
      .slice(0, 10)
      .map((x) => x.id);
    const found = index.nearest(probe, 10).map((n) => n.id);
    if (found[0] === exact[0]) sameBest++;
    overlap += found.filter((id) => exact.includes(id)).length;
  }
  check("8-bit index always finds the truly closest face", sameBest === 25, `${sameBest}/25 queries`);
  // Ranks below the closest are random strangers at ~0 similarity, where 8-bit rounding may reorder
  // meaningless near-ties. What matters: every genuinely similar face is found.
  const source = faces[1234];
  const planted = [0.03, 0.05, 0.07, 0.09, 0.11].map((noise, i) => {
    const v = near(source, noise);
    index.add(`look${i}`, v);
    return `look${i}`;
  });
  const hitsAll = index.nearest(near(source, 0.04), 10).map((n) => n.id);
  check("8-bit index finds every lookalike among 3,000 voters", ["v1234", ...planted].every((id) => hitsAll.includes(id)), `${overlap}/250 overlap with exact top-10`);

  const twin = near(faces[500], 0.075);
  index.add("twin", twin);
  const hits = index.nearest(near(twin, 0.03), 3, "v500").map((n) => n.id);
  check("Lookalike found among 3,000 voters (claimed voter excluded)", hits[0] === "twin" && !hits.includes("v500"), hits.join(","));

  index.add("v7", faces[8]);
  check("Re-enrolling a voter updates their entry instead of duplicating it", index.size === 3006 && index.nearest(faces[8], 2).map((n) => n.id).sort().join() === "v7,v8");
}

livenessTests().then(() => {
  console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
  process.exit(failed ? 1 : 0);
});
