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
  FACE_MATCH_THRESHOLD,
  IMPOSTOR_MARGIN,
  PROBE_CONSISTENCY_LIMIT,
  matchScore,
  probeSpread,
} from "../src/lib/faceMath";
import { fuseDescriptors } from "../src/lib/face.client";
import { proxy } from "../src/proxy";
import { LIVENESS_STEPS, randomSteps, verifyLiveness, type LivenessStep, type LivenessStepEvidence } from "../src/lib/liveness";
import { issueChallenge, redeemChallenge } from "../src/lib/livenessChallenge";
import { FaceIndex } from "../src/lib/faceIndex";
import { faceDistance } from "../src/lib/faceMath";

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
  const t = { mean: Array.from({ length: 128 }, (_, i) => Math.sin(i) / 10), samples: [] as number[][] };
  const blob = encryptFaceTemplate(t, "27310001");
  check("Template is not stored in plaintext", !blob.includes("0.0") && blob.startsWith("v1."));
  check("Owner can decrypt their template", decryptFaceTemplate(blob, "27310001")?.mean[5] === t.mean[5]);
  check("Template swapped into another voter fails", decryptFaceTemplate(blob, "27310002") === null);
  const tampered = blob.slice(0, -4) + (blob.endsWith("A") ? "BBBB" : "AAAA");
  check("Tampered ciphertext fails", decryptFaceTemplate(tampered, "27310001") === null);
}

// ---------------------------------------------------------- face matching
{
  let seed = 7;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  const unit = (v: number[]) => {
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  };
  // Each person is a point; each camera frame adds a little noise (≈0.25 apart frame to frame).
  const person = () => unit(Array.from({ length: 128 }, rand)).map((x) => x * 0.95);
  const frame = (p: number[]) => p.map((x) => x + rand() * 0.032);
  const lookalike = (p: number[]) => p.map((x) => x + rand() * 0.045);
  const reading = (p: number[], n = 5) => Array.from({ length: n }, () => frame(p));
  const enroll = (p: number[]) => {
    const fused = fuseDescriptors(reading(p).map((d) => Float32Array.from(d)));
    return { mean: fused.mean, samples: fused.kept };
  };

  const alice = person();
  const bob = person();
  const aliceTwin = lookalike(alice);
  const tAlice = enroll(alice);
  const tTwin = enroll(aliceTwin);

  const genuine = matchScore(tAlice, reading(alice));
  check("Genuine voter matches", genuine < FACE_MATCH_THRESHOLD, `score ${genuine.toFixed(3)}`);

  const impostor = matchScore(tAlice, reading(bob));
  check("Different person rejected", impostor >= FACE_MATCH_THRESHOLD, `score ${impostor.toFixed(3)}`);

  const twinProbe = reading(aliceTwin);
  const twinAsAlice = matchScore(tAlice, twinProbe);
  const twinAsSelf = matchScore(tTwin, twinProbe);
  const caughtByOneToN = twinAsAlice >= FACE_MATCH_THRESHOLD || twinAsSelf < twinAsAlice + IMPOSTOR_MARGIN;
  check("Lookalike claiming Alice's ID blocked (threshold or 1:N)", caughtByOneToN, `vs Alice ${twinAsAlice.toFixed(3)}, vs self ${twinAsSelf.toFixed(3)}`);

  const mixed = [...reading(alice, 2), ...reading(bob, 3)];
  check("Mixed faces in one scan rejected", probeSpread(mixed) > PROBE_CONSISTENCY_LIMIT, `spread ${probeSpread(mixed).toFixed(3)}`);
  check("Single-person scan is consistent", probeSpread(reading(alice)) <= PROBE_CONSISTENCY_LIMIT, `spread ${probeSpread(reading(alice)).toFixed(3)}`);
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

// --------------------------------------------------------------- liveness
async function livenessTests() {
  let seed = 11;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  const unit = (v: number[]) => v.map((x) => x / Math.hypot(...v));
  const person = () => unit(Array.from({ length: 128 }, rand)).map((x) => x * 0.95);
  const frontal = (p: number[]) => Array.from({ length: 5 }, () => p.map((x) => x + rand() * 0.032));
  const posed = (p: number[]) => p.map((x) => x + rand() * 0.05); // turned or blinking: a bit further off
  const alice = person();
  const bob = person();

  // Telemetry for each move, one reading every 70 ms (about what the browser records).
  let t = 1000;
  const frames = (values: [number, number][]) => values.map(([yaw, ear]) => ({ t: (t += 70), yaw, ear }));
  const move: Record<LivenessStep, () => [number, number][]> = {
    TURN_LEFT: () => [[1, 0.3], [4, 0.3], [9, 0.3], [15, 0.3], [19, 0.3]],
    TURN_RIGHT: () => [[18, 0.3], [6, 0.3], [-3, 0.3], [-11, 0.3], [-17, 0.3]],
    BLINK: () => [[0, 0.31], [0, 0.3], [0, 0.12], [0, 0.1], [0, 0.29], [0, 0.31]],
  };
  const evidence = (steps: LivenessStep[], who = alice) => ({
    steps: steps.map((step): LivenessStepEvidence => ({ step, frames: frames(move[step]()), descriptor: posed(who) })),
  });
  const order: LivenessStep[] = ["BLINK", "TURN_LEFT", "TURN_RIGHT"];
  const face = frontal(alice);

  check("Live person doing the moves passes", verifyLiveness(order, evidence(order), face).ok);
  check("Moves in the wrong order rejected", !verifyLiveness(order, evidence(["TURN_LEFT", "BLINK", "TURN_RIGHT"]), face).ok);

  const photo = evidence(order);
  photo.steps[1].frames = frames([[20, 0.3], [20, 0.3], [20, 0.3], [20, 0.3], [20, 0.3]]);
  check("Photo held at an angle (no real turn) rejected", !verifyLiveness(order, photo, face).ok);

  const noBlink = evidence(order);
  noBlink.steps[0].frames = frames([[0, 0.3], [0, 0.3], [0, 0.29], [0, 0.31], [0, 0.3], [0, 0.3]]);
  check("Eyes that never close rejected", !verifyLiveness(order, noBlink, face).ok);

  const tooFast = evidence(order);
  tooFast.steps[1].frames = tooFast.steps[1].frames.map((f, i) => ({ ...f, t: tooFast.steps[1].frames[0].t + i * 10 }));
  check("Moves faster than humanly possible rejected", !verifyLiveness(order, tooFast, face).ok);

  const swapped = evidence(order);
  swapped.steps[2].descriptor = posed(bob);
  check("Someone else doing a move rejected", !verifyLiveness(order, swapped, face).ok);

  check("Missing evidence rejected", !verifyLiveness(order, undefined, face).ok);

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
  let seed = 23;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  const unit = (v: number[]) => v.map((x) => x / Math.hypot(...v));
  const person = () => unit(Array.from({ length: 128 }, rand)).map((x) => x * 0.95);

  const faces = Array.from({ length: 3000 }, person);
  const index = new FaceIndex();
  faces.forEach((f, i) => index.add(`v${i}`, f));
  check("Index holds every voter (no 5,000-style cap, grows past its first block)", index.size === 3000, `${index.size}`);

  let agree = 0;
  for (let q = 0; q < 25; q++) {
    const probe = faces[q * 37].map((x) => x + rand() * 0.05);
    const brute = faces
      .map((f, i) => ({ id: `v${i}`, d: faceDistance(f, probe) }))
      .sort((x, y) => x.d - y.d)
      .slice(0, 10)
      .map((x) => x.id)
      .join();
    if (index.nearest(probe, 10).map((n) => n.id).join() === brute) agree++;
  }
  check("Index finds exactly the same 10 closest faces as checking everyone", agree === 25, `${agree}/25 queries`);

  const twin = faces[500].map((x) => x + rand() * 0.045);
  index.add("twin", twin);
  const hits = index.nearest(twin.map((x) => x + rand() * 0.03), 3, "v500").map((n) => n.id);
  check("Lookalike found among 3,000 voters (claimed voter excluded)", hits[0] === "twin" && !hits.includes("v500"), hits.join(","));

  index.add("v7", faces[8]);
  check("Re-enrolling a voter updates their entry instead of duplicating it", index.size === 3001 && index.nearest(faces[8], 2).map((n) => n.id).sort().join() === "v7,v8");
}

livenessTests().then(() => {
  console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
  process.exit(failed ? 1 : 0);
});
