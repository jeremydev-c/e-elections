import { NextResponse, type NextRequest } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { audit } from "@/lib/audit";
import { getAdmin } from "@/lib/session";
import { clientIp, lockedFor, recordFailure } from "@/lib/rateLimit";
import { seedDatabase, type ResetMode } from "@/lib/seed";
import { Admin, Election, electionStatus } from "@/models/Election";
import { Candidate } from "@/models/Candidate";
import { Voter } from "@/models/Voter";
import { VoteLedger } from "@/models/VoteLedger";

// Inserting ~4,200 candidates can take a while on a cold Atlas cluster.
export const maxDuration = 60;

/** GET /api/seed: database status for the /setup page. */
export async function GET(req: NextRequest) {
  const admin = await getAdmin(req);
  try {
    await connectDB();
    const [hasAdmin, candidates, voters, ballots, election] = await Promise.all([
      Admin.exists({}),
      Candidate.estimatedDocumentCount(),
      Voter.estimatedDocumentCount(),
      VoteLedger.estimatedDocumentCount(),
      Election.findById("current").lean(),
    ]);
    return NextResponse.json({
      ok: true,
      hasAdmin: !!hasAdmin,
      admin: admin?.username ?? null,
      counts: { candidates, voters, ballots },
      election: election
        ? { name: election.name, status: electionStatus(election), closesAt: election.closesAt }
        : null,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}

/**
 * POST /api/seed { reset?: "none" | "votes" | "all" }
 * First run (no admin yet): anyone may seed, which also creates the admin
 * and returns its password ONCE. After that, an admin session is required.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const reset: ResetMode = body.reset === "all" || body.reset === "votes" ? body.reset : "none";

  const ipKey = `seed:${clientIp(req)}`;
  if (lockedFor(ipKey)) return NextResponse.json({ error: "Too many seed requests. Wait a few minutes." }, { status: 429 });
  recordFailure(ipKey, 5, 5 * 60_000);

  await connectDB();
  const admin = await getAdmin(req);
  const bootstrap = !(await Admin.exists({}));
  if (!admin && !bootstrap) {
    return NextResponse.json({ error: "Election official login required to seed or reset." }, { status: 401 });
  }
  if (bootstrap && reset !== "none") {
    return NextResponse.json({ error: "Seed once first, then log in to reset." }, { status: 400 });
  }

  try {
    const result = await seedDatabase({ reset });
    await audit(reset === "none" ? "DATABASE_SEEDED" : "ELECTION_RESET", {
      req,
      severity: reset === "all" ? "critical" : reset === "votes" ? "warning" : "info",
      actor: admin?.username ?? "first-run setup",
      detail: reset === "none" ? "Seed / top-up" : `Reset: ${reset}`,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("Seed failed:", err);
    return NextResponse.json({ error: "Seeding failed. Check the server log." }, { status: 500 });
  }
}
