import { NextResponse, connection } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { logTamperOnce } from "@/lib/audit";
import { auditLedger, tallyFromLedger } from "@/lib/ledger";
import { Voter } from "@/models/Voter";
import { Candidate } from "@/models/Candidate";
import { Election, electionStatus } from "@/models/Election";

const pct = (n: number, total: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);

/**
 * GET /api/results: live national tally + full SHA-256 ledger audit.
 * Vote counts come from the verified ledger, not from the candidate cache;
 * a cache that disagrees with the ledger is reported as tampering.
 */
export async function GET() {
  await connection(); // always live, never prerendered
  try {
    await connectDB();
    const [totalRegistered, election, { blocks, head, audit }] = await Promise.all([
      Voter.estimatedDocumentCount(),
      Election.findById("current").lean(),
      auditLedger(),
    ]);
    const tally = tallyFromLedger(blocks);

    // Candidates that have votes in either the ledger or the cache.
    const touched = await Candidate.find(
      { $or: [{ voteCount: { $gt: 0 } }, { _id: { $in: [...tally.keys()] } }, { position: "PRESIDENT" }] },
      { name: 1, party: 1, partyColor: 1, position: 1, voteCount: 1 }
    ).lean();

    const cacheDrift = touched
      .filter((c) => (c.voteCount ?? 0) !== (tally.get(String(c._id)) ?? 0))
      .map((c) => ({ id: String(c._id), name: c.name, cached: c.voteCount ?? 0, ledger: tally.get(String(c._id)) ?? 0 }));

    await logTamperOnce([
      ...audit.issues.map((i) => `${i.problem} #${i.seq}`),
      ...cacheDrift.map((d) => `TALLY_CACHE ${d.name}: ${d.cached} vs ledger ${d.ledger}`),
    ]);

    const presidential = touched
      .filter((c) => c.position === "PRESIDENT")
      .map((c) => ({ id: String(c._id), name: c.name, party: c.party, partyColor: c.partyColor, votes: tally.get(String(c._id)) ?? 0 }))
      .sort((a, z) => z.votes - a.votes || a.name.localeCompare(z.name));
    const totalPresVotes = presidential.reduce((acc, c) => acc + c.votes, 0);

    const byCounty = new Map<string, number>();
    for (const b of blocks) byCounty.set(b.county ?? "Unspecified", (byCounty.get(b.county ?? "Unspecified") ?? 0) + 1);

    return NextResponse.json({
      serverTime: new Date().toISOString(),
      election: {
        name: election?.name ?? "General Election 2027",
        status: election ? electionStatus(election) : "OPEN",
        totalRegistered,
        totalVotesCast: blocks.length,
        turnoutPercent: pct(blocks.length, totalRegistered),
      },
      audit: {
        ledgerIntact: audit.intact && cacheDrift.length === 0,
        chainIntact: audit.intact,
        blocksVerified: audit.checked,
        tamperedVotes: audit.tamperedVotes,
        issues: audit.issues.slice(0, 25),
        cacheDrift: cacheDrift.slice(0, 25),
        latestHash: head?.lastHash ?? null,
        headSeq: head?.seq ?? 0,
      },
      presidential: {
        title: "Presidential Election (Republic of Kenya)",
        totalVotes: totalPresVotes,
        candidates: presidential.map((c) => ({ ...c, percent: pct(c.votes, totalPresVotes) })),
      },
      ballotsByCounty: [...byCounty.entries()]
        .map(([county, ballots]) => ({ county, ballots }))
        .sort((a, z) => z.ballots - a.ballots),
    });
  } catch (err: unknown) {
    console.error("Results API error:", err);
    return NextResponse.json({ error: "Results are temporarily unavailable." }, { status: 500 });
  }
}
