import { NextResponse, type NextRequest } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { loadLedger, tallyFromLedger } from "@/lib/ledger";
import { Candidate } from "@/models/Candidate";
import { POSITIONS, POSITION_LABELS, POSITION_LEVEL, type Position } from "@/lib/positions";
import { getCounty, getConstituency, getWard } from "@/lib/regions";

/** GET /api/results/region?position=GOVERNOR&regionCode=47: tally for one regional race. */
export async function GET(req: NextRequest) {
  // Read the query BEFORE the try/catch so Next's prerender bail-out isn't swallowed.
  const position = req.nextUrl.searchParams.get("position") as Position | null;
  const regionCode = String(parseInt(req.nextUrl.searchParams.get("regionCode") ?? "", 10) || "KE");

  if (!position || !POSITIONS.includes(position)) {
    return NextResponse.json({ error: "Invalid position." }, { status: 400 });
  }

  try {
    await connectDB();
    const [candidates, blocks] = await Promise.all([
      Candidate.find({ position, regionCode: position === "PRESIDENT" ? "KE" : regionCode })
        .select("name party partyColor")
        .lean(),
      loadLedger(),
    ]);
    const tally = tallyFromLedger(blocks);

    const level = POSITION_LEVEL[position];
    const regionTitle =
      level === "county"
        ? `${getCounty(regionCode)?.name ?? regionCode} County`
        : level === "constituency"
          ? `${getConstituency(regionCode)?.name ?? regionCode} Constituency`
          : level === "ward"
            ? `${getWard(regionCode)?.name ?? regionCode} Ward`
            : "National";

    const rows = candidates
      .map((c) => ({ id: String(c._id), name: c.name, party: c.party, partyColor: c.partyColor, votes: tally.get(String(c._id)) ?? 0 }))
      .sort((a, z) => z.votes - a.votes || a.name.localeCompare(z.name));
    const totalVotes = rows.reduce((sum, c) => sum + c.votes, 0);

    return NextResponse.json({
      position,
      positionLabel: POSITION_LABELS[position],
      regionCode,
      regionTitle,
      totalVotes,
      candidates: rows.map((c) => ({ ...c, percent: totalVotes > 0 ? Math.round((c.votes / totalVotes) * 1000) / 10 : 0 })),
    });
  } catch (err: unknown) {
    console.error("Regional results API error:", err);
    return NextResponse.json({ error: "Regional results are temporarily unavailable." }, { status: 500 });
  }
}
