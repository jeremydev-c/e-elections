import { NextResponse, type NextRequest } from "next/server";
import { BALLOT_COOKIE, cookieOptions, getVoterSession } from "@/lib/session";
import { alreadyVotedMessage, regionCodeFor } from "@/lib/positions";
import { Voter } from "@/models/Voter";
import { connectDB } from "@/lib/mongodb";
import { Candidate, POSITIONS, POSITION_LABELS } from "@/models/Candidate";
import { getCounty, getConstituency, getWard } from "@/lib/regions";

/** GET /api/ballot/candidates: return the 6 dynamic ballots tailored to voter's location. */
export async function GET(req: NextRequest) {
  const session = await getVoterSession(req);
  if (!session) {
    return NextResponse.json({ error: "Voting session required. Please authenticate." }, { status: 401 });
  }

  await connectDB();

  // Re-check in the database: the voter may have voted elsewhere (e.g. USSD).
  const voter = await Voter.findById(session.voterId, { idNumber: 1, hasVoted: 1, votedAt: 1 }).lean();
  if (!voter || voter.hasVoted) {
    const res = NextResponse.json(
      { error: voter ? alreadyVotedMessage(voter.idNumber, voter.votedAt) : "Voter not found.", hasVoted: !!voter },
      { status: 403 }
    );
    res.cookies.set(BALLOT_COOKIE, "", cookieOptions(0));
    return res;
  }

  const county = getCounty(session.countyCode);
  const constituency = getConstituency(session.constituencyCode);
  const ward = getWard(session.wardCode);

  // Fetch all candidates for the voter's exact jurisdiction
  const candidates = await Candidate.find({
    $or: POSITIONS.map((position) => ({ position, regionCode: regionCodeFor(position, session) })),
  })
    .select("name party partyColor position regionCode photoUrl")
    .sort({ party: 1, name: 1 })
    .lean();

  // Group by position
  const ballots = POSITIONS.map((pos) => {
    const list = candidates.filter((c) => c.position === pos);
    let regionLabel = "Republic of Kenya";
    if (pos === "GOVERNOR" || pos === "SENATOR" || pos === "WOMAN_REP") {
      regionLabel = `${county?.name ?? session.countyCode} County`;
    } else if (pos === "MP") {
      regionLabel = `${constituency?.name ?? session.constituencyCode} Constituency`;
    } else if (pos === "MCA") {
      regionLabel = `${ward?.name ?? session.wardCode} Ward`;
    }

    return {
      position: pos,
      title: POSITION_LABELS[pos],
      regionLabel,
      candidates: list.map((c) => ({
        id: String(c._id),
        name: c.name,
        party: c.party,
        partyColor: c.partyColor,
        photoUrl: c.photoUrl,
      })),
    };
  });

  return NextResponse.json({
    voter: {
      fullName: session.fullName,
      countyName: county?.name ?? session.countyCode,
      constituencyName: constituency?.name ?? session.constituencyCode,
      wardName: ward?.name ?? session.wardCode,
    },
    ballots,
  });
}
