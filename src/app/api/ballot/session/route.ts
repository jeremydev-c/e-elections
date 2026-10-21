import { NextResponse, type NextRequest } from "next/server";
import { getVoterSession, BALLOT_COOKIE, cookieOptions } from "@/lib/session";
import { connectDB } from "@/lib/mongodb";
import { Voter } from "@/models/Voter";
import { Election, electionStatus } from "@/models/Election";
import { getCounty, getConstituency, getWard } from "@/lib/regions";

/** GET /api/ballot/session: verify current voting session and region context. */
export async function GET(req: NextRequest) {
  const session = await getVoterSession(req);
  if (!session) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  await connectDB();
  const voter = await Voter.findById(session.voterId, { hasVoted: 1, idNumber: 1, fullName: 1 }).lean();
  if (!voter || voter.hasVoted) {
    const res = NextResponse.json({ authenticated: false, hasVoted: voter?.hasVoted ?? true }, { status: 401 });
    res.cookies.set(BALLOT_COOKIE, "", cookieOptions(0));
    return res;
  }

  const election = await Election.findById("current").lean();
  const status = election ? electionStatus(election) : "OPEN";

  const county = getCounty(session.countyCode);
  const constituency = getConstituency(session.constituencyCode);
  const ward = getWard(session.wardCode);

  return NextResponse.json({
    authenticated: true,
    electionStatus: status,
    voter: {
      voterId: session.voterId,
      fullName: session.fullName,
      idNumber: voter.idNumber,
      countyCode: session.countyCode,
      constituencyCode: session.constituencyCode,
      wardCode: session.wardCode,
      countyName: county?.name ?? session.countyCode,
      constituencyName: constituency?.name ?? session.constituencyCode,
      wardName: ward?.name ?? session.wardCode,
    },
  });
}

/** DELETE /api/ballot/session: clear voting session. */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(BALLOT_COOKIE, "", cookieOptions(0));
  return res;
}
