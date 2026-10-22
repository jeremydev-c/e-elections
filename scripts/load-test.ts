/**
 * Load test: how E-ELECTIONS behaves as the register and the traffic grow.
 *
 *   Part 1 (offline, no network): the cost of the 1:N face check for one login,
 *          as the number of enrolled voters grows, extrapolated to Kenya's register:
 *          first downloading every template (the old way), then with the face index.
 *   Part 2 (live): many voters doing the full flow at the same time (ID check →
 *          liveness → face → ballot → cast), and many people watching live results.
 *
 *   1. Start the production server on the isolated test database:
 *        MONGODB_DB=e_elections_test npx next start -p 3005
 *   2. npx tsx scripts/load-test.ts
 *
 * Like the end-to-end test it refuses to run unless the server reports the
 * e_elections_test database. Part 2 resets that database. The live part
 * downloads every enrolled template on each face login, so it is kept small
 * (about 70 MB of internet traffic between the server and MongoDB Atlas).
 * Results are written to scripts/load-results.json.
 */
import fs from "node:fs";
import path from "node:path";
process.loadEnvFile(path.resolve(__dirname, "..", ".env.local"));
process.env.MONGODB_DB = "e_elections_test";

import mongoose from "mongoose";
import { connectDB } from "../src/lib/mongodb";
import { seedDatabase } from "../src/lib/seed";
import { decryptFaceTemplate, encryptFaceTemplate } from "../src/lib/biometricVault";
import { matchScore } from "../src/lib/faceMath";
import { FaceIndex, NEAREST_K } from "../src/lib/faceIndex";
import { fuseDescriptors } from "../src/lib/face.client";
import { getConstituency, getCounty, getWard } from "../src/lib/regions";
import { Voter } from "../src/models/Voter";

const BASE = process.env.E2E_BASE ?? "http://localhost:3005";
const KENYA_REGISTER = 22_120_458; // registered voters, 2022 General Election (IEBC)
const OFFLINE_SIZES = [1_000, 5_000, 10_000];
const INDEX_SIZES = [10_000, 100_000, 1_000_000];
const REGISTER = 60; // voters enrolled for the live part
const WAVES = [5, 10, 20]; // voters going through the whole flow at the same moment
const RESULT_WATCHERS = 30; // people refreshing live results at the same moment
const RESULT_ROUNDS = 3;
const WARDS = ["812", "818", "1366", "1371", "1", "11", "1196", "1186", "708", "701"];

// ------------------------------------------------------------------ helpers
let seed = 4242;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
const unit = (v: number[]) => v.map((x) => x / Math.hypot(...v));
const newFace = () => unit(Array.from({ length: 128 }, rand)).map((x) => x * 0.95);
const frame = (p: number[]) => p.map((x) => x + rand() * 0.032);
const reading = (p: number[]) => Array.from({ length: 5 }, () => frame(p));
const template = (face: number[]) => {
  const fused = fuseDescriptors(reading(face).map((d) => Float32Array.from(d)));
  return { mean: fused.mean, samples: fused.kept };
};

const ms = (t0: number) => performance.now() - t0;
const round = (x: number, d = 0) => Math.round(x * 10 ** d) / 10 ** d;
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, z) => a - z);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const stats = (xs: number[]) => ({ p50: round(quantile(xs, 0.5)), p95: round(quantile(xs, 0.95)), max: round(Math.max(0, ...xs)) });

async function call(method: string, url: string, body?: unknown, cookie?: string) {
  const t0 = performance.now();
  const res = await fetch(BASE + url, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, time: ms(t0), setCookie: res.headers.getSetCookie?.() ?? [] };
}
const cookieFrom = (setCookie: string[], name: string) => setCookie.find((s) => s.startsWith(`${name}=`))?.split(";")[0];

// Simulated liveness telemetry for the moves the server asks for.
let clock = 0;
const MOVES: Record<string, [number, number][]> = {
  TURN_LEFT: [[1, 0.3], [5, 0.3], [10, 0.3], [16, 0.3], [19, 0.3]],
  TURN_RIGHT: [[2, 0.3], [-4, 0.3], [-9, 0.3], [-15, 0.3], [-18, 0.3]],
  BLINK: [[0, 0.31], [0, 0.3], [0, 0.11], [0, 0.1], [0, 0.29], [0, 0.31]],
};
const evidence = (steps: string[], face: number[]) => ({
  steps: steps.map((step) => ({
    step,
    frames: MOVES[step].map(([yaw, ear]) => ({ t: (clock += 70), yaw, ear })),
    descriptor: face.map((x) => x + rand() * 0.05),
  })),
});

// ------------------------------------------------------------------ part 1: offline 1:N cost
function offlineOneToN() {
  console.log("Part 1: cost of the 1:N face check per login (offline)");
  const rows: { enrolled: number; decryptAndMatchMs: number; bytesDownloaded: number }[] = [];
  let bytesPerTemplate = 0;
  for (const n of OFFLINE_SIZES) {
    const blobs: { blob: string; id: string }[] = [];
    for (let i = 0; i < n; i++) {
      const id = String(40_000_000 + i);
      blobs.push({ id, blob: encryptFaceTemplate(template(newFace()), id) });
    }
    const bytes = blobs.reduce((s, b) => s + b.blob.length, 0);
    bytesPerTemplate = bytes / n;
    const probe = reading(newFace());
    const t0 = performance.now();
    for (const { blob, id } of blobs) {
      const t = decryptFaceTemplate(blob, id);
      if (t) matchScore(t, probe);
    }
    const t = ms(t0);
    rows.push({ enrolled: n, decryptAndMatchMs: round(t), bytesDownloaded: bytes });
    console.log(`  ${n.toLocaleString()} enrolled: ${round(t)} ms CPU, ${(bytes / 1e6).toFixed(1)} MB fetched per login`);
  }
  const last = rows[rows.length - 1];
  const scale = KENYA_REGISTER / last.enrolled;
  const projection = {
    enrolled: KENYA_REGISTER,
    cpuSecondsPerLogin: round((last.decryptAndMatchMs * scale) / 1000, 1),
    gigabytesPerLogin: round((bytesPerTemplate * KENYA_REGISTER) / 1e9, 1),
  };
  console.log(`  Projected for ${KENYA_REGISTER.toLocaleString()} voters: ${projection.cpuSecondsPerLogin} s CPU and ${projection.gigabytesPerLogin} GB per login`);
  return { bytesPerTemplate: round(bytesPerTemplate), rows, projection, oldCap: 5000 };
}

/** The same 1:N check with the in-memory face index: search everyone, fetch only the K closest templates. */
function offlineIndex(bytesPerTemplate: number) {
  console.log("\nPart 1b: 1:N with the in-memory face index (offline)");
  const rows: { enrolled: number; searchMs: number; memoryMB: number; bytesDownloaded: number }[] = [];
  const index = new FaceIndex();
  let added = 0;
  for (const n of INDEX_SIZES) {
    for (; added < n; added++) index.add(`v${added}`, newFace());
    const probes = Array.from({ length: 10 }, () => newFace());
    const t0 = performance.now();
    for (const p of probes) index.nearest(p, NEAREST_K);
    const searchMs = ms(t0) / probes.length;
    const row = { enrolled: n, searchMs: round(searchMs, 1), memoryMB: round((n * 128 * 4) / 1e6), bytesDownloaded: Math.round(NEAREST_K * bytesPerTemplate) };
    rows.push(row);
    console.log(`  ${n.toLocaleString()} enrolled: ${row.searchMs} ms search, ${row.memoryMB} MB in memory, ${(row.bytesDownloaded / 1e3).toFixed(0)} KB fetched per login`);
  }
  const last = rows[rows.length - 1];
  const projection = {
    enrolled: KENYA_REGISTER,
    searchMsPerLogin: round((last.searchMs * KENYA_REGISTER) / last.enrolled),
    memoryGB: round((KENYA_REGISTER * 128 * 4) / 1e9, 1),
    kilobytesPerLogin: round(last.bytesDownloaded / 1e3),
  };
  console.log(`  Projected for ${KENYA_REGISTER.toLocaleString()} voters: ${projection.searchMsPerLogin} ms search on one server, ${projection.memoryGB} GB memory, ${projection.kilobytesPerLogin} KB per login`);
  return { k: NEAREST_K, rows, projection };
}

// ------------------------------------------------------------------ part 2: live load
type V = { idNumber: string; face: number[] };

async function enrol(n: number): Promise<V[]> {
  const voters: V[] = [];
  const docs = [];
  for (let i = 0; i < n; i++) {
    const idNumber = String(32_000_000 + i);
    const face = newFace();
    const w = getWard(WARDS[i % WARDS.length])!;
    voters.push({ idNumber, face });
    docs.push({
      idNumber,
      fullName: `Load Voter ${idNumber}`,
      phone: `07${idNumber.slice(-8)}`,
      county: getCounty(w.countyCode)?.name,
      constituency: getConstituency(w.constituencyCode)?.name,
      ward: w.name,
      countyCode: w.countyCode,
      constituencyCode: w.constituencyCode,
      wardCode: w.code,
      faceTemplate: encryptFaceTemplate(template(face), idNumber),
    });
  }
  await Voter.insertMany(docs);
  return voters;
}

type StepTimes = { lookup: number; liveness: number; face: number; ballot: number; cast: number; total: number };

async function vote(v: V): Promise<{ ok: boolean; failedAt?: string; status?: number; times?: StepTimes }> {
  const t0 = performance.now();
  const lk = await call("POST", "/api/auth/voter/lookup", { idNumber: v.idNumber });
  if (lk.status !== 200) return { ok: false, failedAt: "lookup", status: lk.status };
  const ch = await call("POST", "/api/auth/voter/liveness", { idNumber: v.idNumber });
  if (ch.status !== 200) return { ok: false, failedAt: "liveness", status: ch.status };
  const f = await call("POST", "/api/auth/voter/face", {
    idNumber: v.idNumber,
    descriptors: reading(v.face),
    liveness: { token: ch.data.token, evidence: evidence(ch.data.steps, v.face) },
  });
  if (f.status !== 200) return { ok: false, failedAt: "face", status: f.status };
  const cookie = cookieFrom(f.setCookie, "ee_ballot");
  const b = await call("GET", "/api/ballot/candidates", undefined, cookie);
  if (b.status !== 200) return { ok: false, failedAt: "ballot", status: b.status };
  const selections: Record<string, string> = {};
  for (const ballot of (b.data.ballots ?? []) as { position: string; candidates: { id: string }[] }[]) {
    if (ballot.candidates.length) selections[ballot.position] = ballot.candidates[0].id;
  }
  const c = await call("POST", "/api/cast-vote", { selections }, cookie);
  if (c.status !== 200) return { ok: false, failedAt: "cast", status: c.status };
  return { ok: true, times: { lookup: lk.time, liveness: ch.time, face: f.time, ballot: b.time, cast: c.time, total: ms(t0) } };
}

async function liveLoad() {
  console.log("\nPart 2: live load against", BASE);
  const health = await call("GET", "/api/health");
  if (health.data.database !== "e_elections_test") {
    throw new Error(`Refusing to run: server database is "${health.data.database}", not e_elections_test.`);
  }
  await connectDB();
  await seedDatabase({ reset: "all" });
  const voters = await enrol(REGISTER);
  console.log(`  ${REGISTER} voters enrolled`);

  const waves = [];
  let next = 0;
  for (const size of WAVES) {
    const group = voters.slice(next, next + size);
    next += size;
    const t0 = performance.now();
    const outcomes = await Promise.all(group.map(vote));
    const wall = ms(t0);
    const ok = outcomes.filter((o) => o.ok);
    const times = ok.map((o) => o.times!);
    const failures: Record<string, number> = {};
    for (const o of outcomes) if (!o.ok) failures[`${o.failedAt} ${o.status}`] = (failures[`${o.failedAt} ${o.status}`] ?? 0) + 1;
    const wave = {
      simultaneousVoters: size,
      votesCast: ok.length,
      wallClockSeconds: round(wall / 1000, 2),
      votesPerSecond: round(ok.length / (wall / 1000), 2),
      totalMs: stats(times.map((t) => t.total)),
      stepP95Ms: {
        lookup: round(quantile(times.map((t) => t.lookup), 0.95)),
        liveness: round(quantile(times.map((t) => t.liveness), 0.95)),
        face: round(quantile(times.map((t) => t.face), 0.95)),
        ballot: round(quantile(times.map((t) => t.ballot), 0.95)),
        cast: round(quantile(times.map((t) => t.cast), 0.95)),
      },
      failures,
    };
    waves.push(wave);
    console.log(`  ${size} at once: ${ok.length}/${size} voted, ${wave.votesPerSecond} votes/s, p95 ${wave.totalMs.p95} ms`, Object.keys(failures).length ? failures : "");
  }

  const readTimes: number[] = [];
  let readErrors = 0;
  const r0 = performance.now();
  for (let round_ = 0; round_ < RESULT_ROUNDS; round_++) {
    const rs = await Promise.all(Array.from({ length: RESULT_WATCHERS }, () => call("GET", "/api/results")));
    for (const r of rs) {
      readTimes.push(r.time);
      if (r.status !== 200) readErrors++;
    }
  }
  const reads = {
    watchers: RESULT_WATCHERS,
    requests: readTimes.length,
    errors: readErrors,
    requestsPerSecond: round(readTimes.length / (ms(r0) / 1000), 1),
    ms: stats(readTimes),
  };
  console.log(`  ${RESULT_WATCHERS} people watching results: ${reads.requestsPerSecond} req/s, p95 ${reads.ms.p95} ms, ${readErrors} errors`);
  return { registerSize: REGISTER, waves, results: reads };
}

async function main() {
  const offline = offlineOneToN();
  const indexed = offlineIndex(offline.bytesPerTemplate);
  const live = await liveLoad();
  const out = {
    date: new Date().toISOString(),
    setup: "Laptop running the production build; database on MongoDB Atlas (free tier) over the internet",
    offlineOneToN: offline,
    offlineFaceIndex: indexed,
    live,
  };
  fs.writeFileSync(path.resolve(__dirname, "load-results.json"), JSON.stringify(out, null, 1));
  console.log("\nSaved scripts/load-results.json");
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
