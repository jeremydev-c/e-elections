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

console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
