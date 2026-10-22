/**
 * Load test: how E-ELECTIONS behaves as the register and the traffic grow.
 *
 *   Part 1 (offline, no network): the cost of the 1:N face check for one login,
 *          as the number of enrolled voters grows, extrapolated to Kenya's register:
 *          first downloading every template (the old way), then with the face index.
 *   Part 2 (live): many voters doing the flow at the same time (ID check → ballot →
 *          cast, after a face match), and many people watching live results.
 *   Part 3 (offline, needs ml-models/ and LFW_DIR): how long the server face engine
 *          takes for one scan (6 camera frames), i.e. how many scans one server can check.
 *
 * The server now checks real camera frames and refuses fake ones, so Part 2 stands in for
 * the face match with the signed ballot session the server issues after one; Part 3
 * measures the face work itself.
 *
 *   1. Start the production server on the isolated test database:
 *        MONGODB_DB=e_elections_test npx next start -p 3005
 *   2. npx tsx scripts/load-test.ts
 *
 * Like the end-to-end test it refuses to run unless the server reports the
 * e_elections_test database. Part 2 resets that database.
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
import { meanEmbedding, templateSimilarity } from "../src/lib/faceMath";
import { FaceIndex, NEAREST_K } from "../src/lib/faceIndex";
import { BALLOT_COOKIE, BALLOT_TTL, signToken } from "../src/lib/session";
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
const unit = (v: number[]) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
const newFace = () => unit(Array.from({ length: 512 }, rand));
const frame = (p: number[]) => unit(p.map((x) => x + rand() * 0.06));
const template = (face: number[]) => {
  const samples = [frame(face), frame(face), frame(face)];
  return { mean: meanEmbedding(samples), samples };
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
    const probe = frame(newFace());
    const t0 = performance.now();
    for (const { blob, id } of blobs) {
      const t = decryptFaceTemplate(blob, id);
      if (t) templateSimilarity(t, probe);
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

/** The same 1:N check with the in-memory face index: search everyone (on all CPU cores), fetch only the K closest templates. */
async function offlineIndex(bytesPerTemplate: number) {
  console.log("\nPart 1b: 1:N with the in-memory face index (offline)");
  const rows: { enrolled: number; searchMs: number; memoryMB: number; bytesDownloaded: number }[] = [];
  const index = new FaceIndex();
  let added = 0;
  for (const n of INDEX_SIZES) {
    for (; added < n; added++) index.add(`v${added}`, newFace());
    const probes = Array.from({ length: 10 }, () => newFace());
    const t0 = performance.now();
    await index.nearestParallel(probes[0], NEAREST_K); // start the worker threads
    for (const p of probes) await index.nearestParallel(p, NEAREST_K);
    const searchMs = ms(t0) / probes.length;
    const row = { enrolled: n, searchMs: round(searchMs, 1), memoryMB: round((n * 512) / 1e6), bytesDownloaded: Math.round(NEAREST_K * bytesPerTemplate) };
    rows.push(row);
    console.log(`  ${n.toLocaleString()} enrolled: ${row.searchMs} ms search, ${row.memoryMB} MB in memory, ${(row.bytesDownloaded / 1e3).toFixed(0)} KB fetched per login`);
  }
  const last = rows[rows.length - 1];
  const projection = {
    enrolled: KENYA_REGISTER,
    searchMsPerLogin: round((last.searchMs * KENYA_REGISTER) / last.enrolled),
    memoryGB: round((KENYA_REGISTER * 512) / 1e9, 1),
    kilobytesPerLogin: round(last.bytesDownloaded / 1e3),
  };
  console.log(`  Projected for ${KENYA_REGISTER.toLocaleString()} voters: ${projection.searchMsPerLogin} ms search on one server, ${projection.memoryGB} GB memory, ${projection.kilobytesPerLogin} KB per login`);
  return { k: NEAREST_K, rows, projection };
}

// ------------------------------------------------------------------ part 2: live load
type V = { idNumber: string; face: number[]; voterId?: string; wardCode: string };

async function enrol(n: number): Promise<V[]> {
  const voters: V[] = [];
  const docs = [];
  for (let i = 0; i < n; i++) {
    const idNumber = String(32_000_000 + i);
    const face = newFace();
    const w = getWard(WARDS[i % WARDS.length])!;
    voters.push({ idNumber, face, wardCode: w.code });
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
  const saved = await Voter.insertMany(docs);
  saved.forEach((d, i) => (voters[i].voterId = String(d._id)));
  return voters;
}

type StepTimes = { lookup: number; ballot: number; cast: number; total: number };

async function vote(v: V): Promise<{ ok: boolean; failedAt?: string; status?: number; times?: StepTimes }> {
  const t0 = performance.now();
  const lk = await call("POST", "/api/auth/voter/lookup", { idNumber: v.idNumber });
  if (lk.status !== 200) return { ok: false, failedAt: "lookup", status: lk.status };
  // The face match itself is Part 3; here, the session the server issues after one.
  const w = getWard(v.wardCode)!;
  const token = await signToken(
    { role: "voter", voterId: v.voterId, fullName: `Load Voter ${v.idNumber}`, countyCode: w.countyCode, constituencyCode: w.constituencyCode, wardCode: v.wardCode },
    BALLOT_TTL
  );
  const cookie = `${BALLOT_COOKIE}=${token}`;
  const b = await call("GET", "/api/ballot/candidates", undefined, cookie);
  if (b.status !== 200) return { ok: false, failedAt: "ballot", status: b.status };
  const selections: Record<string, string> = {};
  for (const ballot of (b.data.ballots ?? []) as { position: string; candidates: { id: string }[] }[]) {
    if (ballot.candidates.length) selections[ballot.position] = ballot.candidates[0].id;
  }
  const c = await call("POST", "/api/cast-vote", { selections }, cookie);
  if (c.status !== 200) return { ok: false, failedAt: "cast", status: c.status };
  return { ok: true, times: { lookup: lk.time, ballot: b.time, cast: c.time, total: ms(t0) } };
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

// ------------------------------------------------------------------ part 3: face engine per scan
/** Server time for one scan: 6 frames decoded, detected, aligned and turned into identity vectors (frontal ones read twice). */
async function faceEngine() {
  const { faceModelsInstalled, decodeImage, detectFaces, alignFace, embedAligned, sessions } = await import("../src/lib/faceEngine");
  const dir = process.env.LFW_DIR;
  if (!faceModelsInstalled() || !dir) {
    console.log("\nPart 3: skipped (needs ml-models/ and LFW_DIR)");
    return null;
  }
  console.log("\nPart 3: server face engine, one scan = 6 camera frames");
  await sessions();
  const people = fs.readdirSync(path.join(dir, "lfw")).slice(0, 40);
  const times: number[] = [];
  for (const name of people) {
    const files = fs.readdirSync(path.join(dir, "lfw", name)).slice(0, 1);
    const buf = fs.readFileSync(path.join(dir, "lfw", name, files[0]));
    const t0 = performance.now();
    for (let f = 0; f < 6; f++) {
      const img = await decodeImage(buf);
      const face = (await detectFaces(img))[0];
      // As in a real scan (lib/faceScan.ts): flip averaging on the 3 frontal frames only.
      if (face) await embedAligned([alignFace(img, face)], f < 3);
    }
    times.push(ms(t0));
  }
  const p50 = quantile(times, 0.5);
  const out = { scans: times.length, msPerScan: stats(times), scansPerMinutePerServer: round(60_000 / p50) };
  console.log(`  ${out.msPerScan.p50} ms per scan (p95 ${out.msPerScan.p95} ms): about ${out.scansPerMinutePerServer} scans a minute on this machine`);
  return out;
}

async function main() {
  const offline = offlineOneToN();
  const indexed = await offlineIndex(offline.bytesPerTemplate);
  const engine = await faceEngine();
  const live = await liveLoad();
  const out = {
    date: new Date().toISOString(),
    setup: "Laptop running the production build; database on MongoDB Atlas (free tier) over the internet",
    offlineOneToN: offline,
    offlineFaceIndex: indexed,
    faceEngine: engine,
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
