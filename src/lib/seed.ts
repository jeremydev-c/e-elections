/**
 * Seeds the e_elections database:
 *   - Election window (opens now, closes in ELECTION_DAYS days)
 *   - First admin account (only if none exists)
 *   - FICTIONAL demo candidates for all 6 seats across all 47 counties,
 *     290 constituencies and 1,450 wards
 *
 * reset: "votes" wipes the ledger and re-opens every voter (keeps voters);
 *        "all"   also deletes every voter and regenerates candidates.
 */
import { connectDB } from "@/lib/mongodb";
import { COUNTIES, getConstituency, getCounty, getWard } from "@/lib/regions";
import { hashPassword } from "@/lib/password";
import { randomToken } from "@/lib/hashChain";
import { POSITION_LEVEL, type Position } from "@/lib/positions";
import { Candidate } from "@/models/Candidate";
import { Voter } from "@/models/Voter";
import { VoteLedger, ChainHead } from "@/models/VoteLedger";
import { TallyShard } from "@/models/TallyShard";
import { Election, Admin, electionStatus } from "@/models/Election";

export type ResetMode = "none" | "votes" | "all";

export type SeedResult = {
  log: string[];
  admin?: { username: string; password: string };
  counts: { candidates: number; voters: number; ballots: number };
};

// ---- Fictional parties (not real Kenyan parties) ----------------------------
const PARTIES = [
  { name: "Umoja Progressive Alliance", color: "#16a34a" },
  { name: "National Renewal Movement", color: "#2563eb" },
  { name: "Mwangaza Democratic Party", color: "#f59e0b" },
  { name: "Haki na Usawa Coalition", color: "#dc2626" },
  { name: "Green Future Kenya", color: "#0d9488" },
  { name: "Independent", color: "#64748b" },
];

const FIRST_M = ["Brian", "Kevin", "Dennis", "Samuel", "Peter", "Joseph", "Daniel", "Collins", "Emmanuel", "Victor", "Moses", "Felix", "Isaac", "Martin", "Kennedy", "Stephen", "Hassan", "Omar", "Abdi", "Wycliffe"];
const FIRST_F = ["Faith", "Mercy", "Grace", "Esther", "Joyce", "Ann", "Caroline", "Purity", "Lucy", "Diana", "Agnes", "Beatrice", "Halima", "Amina", "Wanjiru", "Akinyi", "Naliaka", "Chebet", "Nafula", "Zawadi"];
const LAST = ["Kamau", "Otieno", "Wanjala", "Mutua", "Kiprono", "Achieng", "Njoroge", "Ochieng", "Kibet", "Mwangi", "Odhiambo", "Wambua", "Cheruiyot", "Nyaga", "Barasa", "Onyango", "Mohamed", "Korir", "Muthoni", "Ndungu", "Gitau", "Omondi", "Kariuki", "Wekesa", "Rotich", "Atieno", "Musyoka", "Langat", "Haji", "Juma"];

type NewCandidate = {
  name: string;
  party: string;
  partyColor: string;
  position: Position;
  regionCode: string;
  county?: string;
  constituency?: string;
  ward?: string;
};

/** Region names for a candidate's regionCode (none for President). */
function regionNames(position: Position, regionCode: string) {
  const level = POSITION_LEVEL[position];
  if (level === "county") return { county: getCounty(regionCode)?.name };
  if (level === "constituency") {
    const c = getConstituency(regionCode);
    return { county: c && getCounty(c.countyCode)?.name, constituency: c?.name };
  }
  if (level === "ward") {
    const w = getWard(regionCode);
    return {
      county: w && getCounty(w.countyCode)?.name,
      constituency: w && getConstituency(w.constituencyCode)?.name,
      ward: w?.name,
    };
  }
  return {};
}

/** Deterministic candidate list, identical on every run. */
function buildCandidates(): NewCandidate[] {
  let state = 20270809;
  const rand = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
  const used = new Set<string>();
  const fakeName = (female = rand() < 0.4) => {
    for (;;) {
      const n = `${pick(female ? FIRST_F : FIRST_M)} ${pick(LAST)} ${pick(LAST)}`;
      if (!used.has(n)) return used.add(n), n;
    }
  };
  const make = (position: Position, regionCode: string, count: number, female?: boolean) =>
    [...PARTIES]
      .sort(() => rand() - 0.5)
      .slice(0, count)
      .map<NewCandidate>((p) => ({
        name: fakeName(female),
        party: p.name,
        partyColor: p.color,
        position,
        regionCode,
        ...regionNames(position, regionCode),
      }));

  const all: NewCandidate[] = [...make("PRESIDENT", "KE", 4)];
  for (const county of COUNTIES) {
    all.push(...make("GOVERNOR", county.code, 3));
    all.push(...make("SENATOR", county.code, 3));
    all.push(...make("WOMAN_REP", county.code, 3, true));
    for (const c of county.constituencies) {
      all.push(...make("MP", c.code, 3));
      for (const w of c.wards) all.push(...make("MCA", w.code, 2));
    }
  }
  return all;
}

export async function seedDatabase({
  reset = "none",
  electionDays = Number(process.env.ELECTION_DAYS ?? 30),
}: { reset?: ResetMode; electionDays?: number } = {}): Promise<SeedResult> {
  const log: string[] = [];
  const conn = await connectDB();
  log.push(`Connected to database "${conn.connection.name}"`);

  // Make sure all unique indexes exist (idNumber, receiptCode, seq ...).
  await Promise.all([Voter, Candidate, VoteLedger, ChainHead, TallyShard, Election, Admin].map((m) => m.syncIndexes()));

  if (reset !== "none") {
    await Promise.all([VoteLedger.deleteMany({}), ChainHead.deleteMany({}), TallyShard.deleteMany({})]);
    if (reset === "all") {
      await Voter.deleteMany({});
      log.push("Reset: all voters, the vote ledger and the chain head were wiped");
    } else {
      await Voter.updateMany({}, { $set: { hasVoted: false }, $unset: { votedAt: 1 } });
      await Candidate.updateMany({}, { $set: { voteCount: 0 } });
      log.push("Reset: vote ledger wiped, every voter can vote again, tallies set to 0");
    }
  }

  // ---- Candidates ----
  const ballots = await VoteLedger.estimatedDocumentCount();
  const candidateCount = await Candidate.estimatedDocumentCount();
  if (reset === "all" || candidateCount === 0) {
    const all = buildCandidates();
    await Candidate.deleteMany({});
    await Candidate.insertMany(all, { ordered: false });
    log.push(`${all.length.toLocaleString()} fictional candidates inserted across all 47 counties`);
  } else {
    // Backfill readable region names on candidates created before they existed.
    const missing = await Candidate.find(
      { position: { $ne: "PRESIDENT" }, county: { $exists: false } },
      { position: 1, regionCode: 1 }
    ).lean();
    if (missing.length) {
      await Candidate.bulkWrite(
        missing.map((c) => ({
          updateOne: { filter: { _id: c._id }, update: { $set: regionNames(c.position as Position, c.regionCode) } },
        }))
      );
      log.push(`Backfilled region names on ${missing.length.toLocaleString()} candidates`);
    }
    log.push(`Candidates kept (${candidateCount.toLocaleString()}; ${ballots} ballots in ledger)`);
  }

  // ---- Backfill region names on older voter records ----
  const oldVoters = await Voter.find({ county: { $exists: false } }, { countyCode: 1, constituencyCode: 1, wardCode: 1 }).lean();
  for (const v of oldVoters) {
    await Voter.updateOne(
      { _id: v._id },
      {
        $set: {
          county: getCounty(v.countyCode)?.name ?? v.countyCode,
          constituency: getConstituency(v.constituencyCode)?.name ?? v.constituencyCode,
          ward: getWard(v.wardCode)?.name ?? v.wardCode,
        },
      }
    );
  }
  if (oldVoters.length) log.push(`Backfilled region names on ${oldVoters.length} voters`);

  // ---- Chain heads: each county's chain starts with its first ballot (lib/castVote.ts) ----

  // ---- Election window ----
  const existing = await Election.findById("current").lean();
  if (!existing || reset !== "none" || electionStatus(existing) !== "OPEN") {
    const opensAt = new Date();
    const closesAt = new Date(opensAt.getTime() + electionDays * 86_400_000);
    await Election.updateOne(
      { _id: "current" },
      { name: "Kenya General Election 2027 (KSEF Demo)", opensAt, closesAt },
      { upsert: true }
    );
    log.push(`Election window OPEN until ${closesAt.toUTCString()}`);
  } else {
    log.push(`Election window kept (closes ${existing.closesAt.toUTCString()})`);
  }

  // ---- First admin ----
  let admin: SeedResult["admin"];
  if (!(await Admin.exists({}))) {
    const username = (process.env.ADMIN_USERNAME ?? "admin").toLowerCase();
    const password = process.env.ADMIN_PASSWORD ?? randomToken(9);
    await Admin.create({ username, passwordHash: await hashPassword(password) });
    admin = { username, password };
    log.push(`Admin account "${username}" created`);
  }

  const [candidates, voters, ballotsNow] = await Promise.all([
    Candidate.estimatedDocumentCount(),
    Voter.estimatedDocumentCount(),
    VoteLedger.estimatedDocumentCount(),
  ]);
  return { log, admin, counts: { candidates, voters, ballots: ballotsNow } };
}
