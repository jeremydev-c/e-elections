/**
 * End-to-end simulated election against a RUNNING server (KSEF write-up, Chapter 4).
 *
 *   1. Start the production server on the isolated test database:
 *        MONGODB_DB=e_elections_test npx next start -p 3005
 *   2. npx tsx scripts/e2e-election-test.ts
 *
 * It refuses to run unless the server reports the e_elections_test database,
 * so the real election data can never be touched. Faces are simulated
 * 128-point descriptors (real camera tests are done with people separately).
 * Results are written to scripts/e2e-results.json.
 */
import fs from "node:fs";
import path from "node:path";
process.loadEnvFile(path.resolve(__dirname, "..", ".env.local"));
process.env.MONGODB_DB = "e_elections_test";

import mongoose from "mongoose";
import { connectDB } from "../src/lib/mongodb";
import { seedDatabase } from "../src/lib/seed";
import { hashPassword } from "../src/lib/password";
import { computeBallotHash, randomToken } from "../src/lib/hashChain";
import { fuseDescriptors } from "../src/lib/face.client";
import { getWard } from "../src/lib/regions";
import { Admin } from "../src/models/Election";
import { Candidate } from "../src/models/Candidate";
import { Voter } from "../src/models/Voter";
import { VoteLedger } from "../src/models/VoteLedger";

const BASE = process.env.E2E_BASE ?? "http://localhost:3005";
const N_SEQUENTIAL = 40; // voters who vote one after another (timed)
const N_PARALLEL = 20; // voters who all cast at the same moment
const N_RACE = 10; // voters who each submit 3 ballots at the same moment
const N_IMPOSTOR = 12; // attempts to unlock a voter with someone else's face

// Wards in the five demo counties (Laikipia, Nairobi, Mombasa, Kisumu, Uasin Gishu)
const WARDS = ["812", "818", "1366", "1371", "1", "11", "1196", "1186", "708", "701"];

// ------------------------------------------------------------------ helpers
let seed = 2027;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
const unit = (v: number[]) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
const newFace = () => unit(Array.from({ length: 128 }, rand)).map((x) => x * 0.95);
const frame = (p: number[]) => p.map((x) => x + rand() * 0.032);
const reading = (p: number[]) => Array.from({ length: 5 }, () => frame(p));

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const pct = (n: number, d: number) => Math.round((n / Math.max(1, d)) * 1000) / 10;
const ms = (t0: number) => Math.round(performance.now() - t0);

async function call(method: string, url: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}) {
  const t0 = performance.now();
  const res = await fetch(BASE + url, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const time = ms(t0);
  const data = await res.json().catch(() => ({}));
  const setCookie = res.headers.getSetCookie?.() ?? [];
  return { status: res.status, data, time, setCookie };
}
const cookieFrom = (setCookie: string[], name: string) => {
  const c = setCookie.find((s) => s.startsWith(`${name}=`) && !s.startsWith(`${name}=;`));
  return c ? c.split(";")[0] : undefined;
};

type TestVoter = { idNumber: string; face: number[]; wardCode: string };
let idCounter = 31000000;
function makeVoter(i: number): TestVoter {
  return { idNumber: String(++idCounter), face: newFace(), wardCode: WARDS[i % WARDS.length] };
}

async function register(v: TestVoter, admin: string, face = v.face) {
  const w = getWard(v.wardCode)!;
  const fused = fuseDescriptors(reading(face).map((d) => Float32Array.from(d)));
  return call("POST", "/api/voters", {
    fullName: `Test Voter ${v.idNumber}`,
    idNumber: v.idNumber,
    phone: `07${v.idNumber.slice(-8)}`,
    countyCode: w.countyCode,
    constituencyCode: w.constituencyCode,
    wardCode: v.wardCode,
    faceDescriptor: fused.mean,
    faceSamples: fused.kept,
  }, admin);
}

// Simulated liveness: the moves the server asked for, as browser telemetry (one reading every 70 ms).
let clock = 0;
const MOVES: Record<string, [number, number][]> = {
  TURN_LEFT: [[1, 0.3], [5, 0.3], [10, 0.3], [16, 0.3], [19, 0.3]],
  TURN_RIGHT: [[2, 0.3], [-4, 0.3], [-9, 0.3], [-15, 0.3], [-18, 0.3]],
  BLINK: [[0, 0.31], [0, 0.3], [0, 0.11], [0, 0.1], [0, 0.29], [0, 0.31]],
};
const livenessEvidence = (steps: string[], face: number[]) => ({
  steps: steps.map((step) => ({
    step,
    frames: MOVES[step].map(([yaw, ear]) => ({ t: (clock += 70), yaw, ear })),
    descriptor: face.map((x) => x + rand() * 0.05),
  })),
});

async function verifyFace(v: TestVoter, face = v.face) {
  const challenge = await call("POST", "/api/auth/voter/liveness", { idNumber: v.idNumber });
  if (challenge.status !== 200) return challenge;
  return call("POST", "/api/auth/voter/face", {
    idNumber: v.idNumber,
    descriptors: reading(face),
    liveness: { token: challenge.data.token, evidence: livenessEvidence(challenge.data.steps, face) },
  });
}

async function pickBallot(cookie: string) {
  const r = await call("GET", "/api/ballot/candidates", undefined, cookie);
  const ballots = (r.data.ballots ?? []) as { position: string; candidates: { id: string }[] }[];
  const selections: Record<string, string> = {};
  for (const b of ballots) {
    if (b.candidates.length) selections[b.position] = b.candidates[Math.floor(((rand() + 1) / 2) * b.candidates.length)].id;
  }
  return { r, selections, complete: ballots.length === 6 && Object.keys(selections).length === 6 };
}

// ------------------------------------------------------------------ main
async function main() {
  const health = await call("GET", "/api/health");
  if (health.data.database !== "e_elections_test") {
    throw new Error(`Refusing to run: server database is "${health.data.database}", not e_elections_test.`);
  }

  console.log("Preparing a fresh test election…");
  await connectDB();
  await seedDatabase({ reset: "all" });
  const adminPassword = randomToken(12);
  await Admin.updateOne(
    { username: "e2e-official" },
    { $set: { username: "e2e-official", passwordHash: await hashPassword(adminPassword) } },
    { upsert: true }
  );
  const login = await call("POST", "/api/admin/session", { username: "e2e-official", password: adminPassword });
  const admin = cookieFrom(login.setCookie, "ee_admin");
  if (!admin) throw new Error("Admin login failed");

  const results: Record<string, unknown> = { date: new Date().toISOString(), base: BASE };

  // ---------------------------------------------------------- 1. registration
  const all: TestVoter[] = Array.from({ length: N_SEQUENTIAL + N_PARALLEL + N_RACE }, (_, i) => makeVoter(i));
  const regTimes: number[] = [];
  let regOk = 0;
  for (const v of all) {
    const r = await register(v, admin);
    regTimes.push(r.time);
    if (r.status === 201) regOk++;
    else console.log("registration failed", v.idNumber, r.status, r.data.error);
  }
  const dupFace = await register({ ...makeVoter(0), face: all[0].face }, admin);
  const dupId = await register({ ...all[1] }, admin);
  const lookalike = all[2].face.map((x) => x + rand() * 0.045);
  const lookalikeReg = await register(makeVoter(0), admin, lookalike);
  results.registration = {
    attempted: all.length,
    registered: regOk,
    avgMs: Math.round(mean(regTimes)),
    duplicateFaceBlocked: dupFace.status === 409,
    duplicateIdBlocked: dupId.status === 409,
    lookalikeFlaggedAsDuplicate: lookalikeReg.status === 409,
  };
  console.log("registration", results.registration);

  // ---------------------------------------------------------- 2. impostors (before anyone votes)
  let impostorRejected = 0;
  for (let i = 0; i < N_IMPOSTOR; i++) {
    const victim = all[i];
    const attacker = all[all.length - 1 - i];
    const r = await verifyFace(victim, attacker.face);
    if (r.status === 401) impostorRejected++;
  }
  results.impostors = { attempts: N_IMPOSTOR, rejected: impostorRejected, falseAcceptRate: pct(N_IMPOSTOR - impostorRejected, N_IMPOSTOR) };
  console.log("impostors", results.impostors);

  // ---------------------------------------------------------- 3. sequential voting (timed)
  const seq = all.slice(0, N_SEQUENTIAL);
  const timing = { lookup: [] as number[], face: [] as number[], ballot: [] as number[], cast: [] as number[], total: [] as number[] };
  let firstTry = 0, secondTry = 0, failedVerify = 0, routedOk = 0, cast = 0;
  const receipts: string[] = [];
  const expected = new Map<string, number>();
  for (const v of seq) {
    const t0 = performance.now();
    const lk = await call("POST", "/api/auth/voter/lookup", { idNumber: v.idNumber });
    timing.lookup.push(lk.time);
    let f = await verifyFace(v);
    if (f.status === 200) firstTry++;
    else {
      f = await verifyFace(v);
      if (f.status === 200) secondTry++;
      else { failedVerify++; continue; }
    }
    timing.face.push(f.time);
    const cookie = cookieFrom(f.setCookie, "ee_ballot")!;
    const b = await pickBallot(cookie);
    timing.ballot.push(b.r.time);
    if (b.complete) routedOk++;
    const c = await call("POST", "/api/cast-vote", { selections: b.selections }, cookie);
    timing.cast.push(c.time);
    if (c.status === 200) {
      cast++;
      receipts.push(c.data.receiptCode);
      for (const id of Object.values(b.selections)) expected.set(id, (expected.get(id) ?? 0) + 1);
      (v as TestVoter & { cookie?: string }).cookie = cookie;
    }
    timing.total.push(ms(t0));
  }
  results.voting = {
    voters: seq.length,
    verifiedFirstTry: firstTry,
    verifiedSecondTry: secondTry,
    notVerified: failedVerify,
    ballotsRoutedCorrectly: routedOk,
    votesCast: cast,
    avgMs: Object.fromEntries(Object.entries(timing).map(([k, v]) => [k, Math.round(mean(v))])),
    maxTotalMs: Math.max(...timing.total),
  };
  console.log("voting", results.voting);

  // ---------------------------------------------------------- 4. double voting
  let dvLookup = 0, dvFace = 0, dvCast = 0, deniedMsg = "";
  for (const v of seq.slice(0, 10) as (TestVoter & { cookie?: string })[]) {
    const lk = await call("POST", "/api/auth/voter/lookup", { idNumber: v.idNumber });
    if (lk.status === 403 && lk.data.hasVoted) { dvLookup++; deniedMsg ||= lk.data.error; }
    const f = await verifyFace(v);
    if (f.status === 403) dvFace++;
    const c = await call("POST", "/api/cast-vote", { selections: {} }, v.cookie);
    if (c.status === 409 || c.status === 401 || c.status === 400) dvCast++;
  }
  results.doubleVoting = { attempts: 30, blockedAtIdCheck: dvLookup, blockedAtFace: dvFace, blockedAtCast: dvCast, sampleMessage: deniedMsg };
  console.log("doubleVoting", results.doubleVoting);

  // ---------------------------------------------------------- 5. same voter, 3 ballots at the same instant
  const race = all.slice(N_SEQUENTIAL + N_PARALLEL);
  let raceAccepted = 0, raceRejected = 0;
  for (const v of race) {
    const f = await verifyFace(v);
    const cookie = cookieFrom(f.setCookie, "ee_ballot")!;
    const b = await pickBallot(cookie);
    const outcomes = await Promise.all([1, 2, 3].map(() => call("POST", "/api/cast-vote", { selections: b.selections }, cookie)));
    const ok = outcomes.filter((o) => o.status === 200);
    raceAccepted += ok.length;
    raceRejected += outcomes.length - ok.length;
    if (ok.length) {
      receipts.push(ok[0].data.receiptCode);
      for (const id of Object.values(b.selections)) expected.set(id, (expected.get(id) ?? 0) + 1);
    }
  }
  results.simultaneousDoubleBallots = { voters: race.length, ballotsSubmitted: race.length * 3, accepted: raceAccepted, rejected: raceRejected };
  console.log("race", results.simultaneousDoubleBallots);

  // ---------------------------------------------------------- 6. many voters casting at once
  const par = all.slice(N_SEQUENTIAL, N_SEQUENTIAL + N_PARALLEL);
  const prepared: { cookie: string; selections: Record<string, string> }[] = [];
  for (const v of par) {
    const f = await verifyFace(v);
    const cookie = cookieFrom(f.setCookie, "ee_ballot");
    if (!cookie) continue;
    const b = await pickBallot(cookie);
    prepared.push({ cookie, selections: b.selections });
  }
  const tPar = performance.now();
  const parOut = await Promise.all(prepared.map((p) => call("POST", "/api/cast-vote", { selections: p.selections }, p.cookie)));
  const parWall = ms(tPar);
  parOut.forEach((o, i) => {
    if (o.status === 200) {
      receipts.push(o.data.receiptCode);
      for (const id of Object.values(prepared[i].selections)) expected.set(id, (expected.get(id) ?? 0) + 1);
    }
  });
  results.parallel = { voters: prepared.length, accepted: parOut.filter((o) => o.status === 200).length, wallClockMs: parWall };
  console.log("parallel", results.parallel);

  // ---------------------------------------------------------- 7. results, tally and receipts
  const resTimes: number[] = [];
  let lastRes = await call("GET", "/api/results");
  for (let i = 0; i < 5; i++) {
    lastRes = await call("GET", "/api/results");
    resTimes.push(lastRes.time);
  }
  const ledgerCount = await VoteLedger.countDocuments();
  const pres = await Candidate.find({ position: "PRESIDENT" }, { _id: 1 }).lean();
  let tallyMatches = true;
  for (const c of lastRes.data.presidential.candidates as { id: string; votes: number }[]) {
    if ((expected.get(c.id) ?? 0) !== c.votes) tallyMatches = false;
  }
  let receiptsVerified = 0;
  for (const code of receipts) {
    const r = await call("GET", `/api/ledger/verify?receiptCode=${encodeURIComponent(code)}`);
    if (r.data.verified) receiptsVerified++;
  }
  // a vote appears in results immediately after it is cast
  const extra = makeVoter(3);
  await register(extra, admin);
  const before = (await call("GET", "/api/results")).data.election.totalVotesCast;
  const fx = await verifyFace(extra);
  const bx = await pickBallot(cookieFrom(fx.setCookie, "ee_ballot")!);
  const castAt = performance.now();
  await call("POST", "/api/cast-vote", { selections: bx.selections }, cookieFrom(fx.setCookie, "ee_ballot")!);
  const after = await call("GET", "/api/results");
  const visibleMs = ms(castAt);
  results.results = {
    ballotsInLedger: ledgerCount,
    resultsReported: lastRes.data.election.totalVotesCast,
    presidentialCandidates: pres.length,
    presidentialTallyMatchesExpected: tallyMatches,
    avgResultsMs: Math.round(mean(resTimes)),
    receiptsChecked: receipts.length,
    receiptsVerified,
    newVoteVisibleInMs: after.data.election.totalVotesCast === before + 1 ? visibleMs : null,
    chainIntact: after.data.audit.ledgerIntact,
  };
  console.log("results", results.results);

  // ---------------------------------------------------------- 8. attacks on the API
  const csrf = await call("POST", "/api/cast-vote", { selections: {} }, undefined, { Origin: "https://evil.example" });
  const nosql = await call("POST", "/api/webauthn/login/options", { idNumber: { $ne: null } });
  // wrong-region ballot: Governor of another county
  const victim = makeVoter(0);
  await register(victim, admin);
  const fv = await verifyFace(victim);
  const vc = cookieFrom(fv.setCookie, "ee_ballot")!;
  const bv = await pickBallot(vc);
  const foreignGov = await Candidate.findOne({ position: "GOVERNOR", regionCode: { $ne: getWard(victim.wardCode)!.countyCode } }).lean();
  const wrongRegion = await call("POST", "/api/cast-vote", { selections: { ...bv.selections, GOVERNOR: String(foreignGov!._id) } }, vc);
  // brute force: wrong faces against one voter
  const bruteStatuses: number[] = [];
  const target = makeVoter(1);
  await register(target, admin);
  for (let i = 0; i < 6; i++) bruteStatuses.push((await verifyFace(target, newFace())).status);
  results.attacks = {
    crossSiteBlocked: csrf.status === 403,
    noSqlInjectionBlocked: nosql.status === 400,
    wrongRegionBallotRejected: wrongRegion.status === 400,
    bruteForceStatuses: bruteStatuses,
    bruteForceLockedAfter: bruteStatuses.indexOf(429),
  };
  console.log("attacks", results.attacks);

  // ---------------------------------------------------------- 9. tampering directly in the database
  const audit = async () => (await call("GET", "/api/ledger/audit")).data.audit as { intact: boolean; issues: { problem: string }[]; ms: number };
  const baseline = await audit();
  const victimBlock = await VoteLedger.findOne().sort({ seq: 1 }).skip(3).lean();
  const lastBlock = await VoteLedger.findOne().sort({ seq: -1 }).lean();
  const otherPres = pres.find((p) => String(p._id) !== (victimBlock!.selections as unknown as Record<string, string>).PRESIDENT)!;
  const tamper: Record<string, { detected: boolean; problems: string[] }> = {};
  const record = (name: string, a: Awaited<ReturnType<typeof audit>>) =>
    (tamper[name] = { detected: !a.intact, problems: [...new Set(a.issues.map((i) => i.problem))] });

  await VoteLedger.updateOne({ _id: victimBlock!._id }, { $set: { "selections.PRESIDENT": String(otherPres._id) } });
  record("changeOneVote", await audit());
  await VoteLedger.replaceOne({ _id: victimBlock!._id }, victimBlock!);

  const forged = { ...victimBlock!, selections: { ...(victimBlock!.selections as unknown as Record<string, string>), PRESIDENT: String(otherPres._id) } };
  const forgedHash = computeBallotHash({ ...forged, selections: forged.selections, county: forged.county ?? undefined, timestamp: new Date(forged.timestamp) });
  await VoteLedger.updateOne({ _id: victimBlock!._id }, { $set: { "selections.PRESIDENT": String(otherPres._id), currentHash: forgedHash } });
  record("changeVoteAndRehash", await audit());
  await VoteLedger.replaceOne({ _id: victimBlock!._id }, victimBlock!);

  await VoteLedger.deleteOne({ _id: lastBlock!._id });
  record("deleteNewestBallot", await audit());
  await VoteLedger.create(lastBlock!);

  const someVoter = await Voter.findOne({ hasVoted: true });
  await Voter.updateOne({ _id: someVoter!._id }, { $set: { hasVoted: false } });
  record("resetVoterToVoteAgain", await audit());
  await Voter.updateOne({ _id: someVoter!._id }, { $set: { hasVoted: true } });

  const cand = await Candidate.findOne({ voteCount: { $gt: 0 } });
  await Candidate.updateOne({ _id: cand!._id }, { $inc: { voteCount: 100 } });
  const inflated = await call("GET", "/api/results");
  tamper.inflateTallyCount = { detected: !inflated.data.audit.ledgerIntact, problems: ["TALLY_CACHE_DRIFT"] };
  const shownVotes = (inflated.data.presidential.candidates as { id: string; votes: number }[]).find((c) => c.id === String(cand!._id))?.votes;
  await Candidate.updateOne({ _id: cand!._id }, { $inc: { voteCount: -100 } });

  const restored = await audit();
  results.tampering = {
    baselineIntact: baseline.intact,
    fullAuditMs: baseline.ms,
    attacks: tamper,
    inflatedTallyIgnoredByResults: shownVotes === undefined || shownVotes < 100,
    intactAfterRestore: restored.intact,
  };
  console.log("tampering", JSON.stringify(results.tampering, null, 1));

  fs.writeFileSync(path.resolve(__dirname, "e2e-results.json"), JSON.stringify(results, null, 2));
  console.log("\nSaved scripts/e2e-results.json");
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("E2E test failed:", err);
  await mongoose.disconnect();
  process.exit(1);
});
