import { NextResponse, type NextRequest } from "next/server";
import { getVoterSession, BALLOT_COOKIE, cookieOptions } from "@/lib/session";
import { audit } from "@/lib/audit";
import { castBallot, CastError } from "@/lib/castVote";

/**
 * POST /api/cast-vote { selections: { PRESIDENT: id, GOVERNOR: id, ... } }
 * Atomically locks the voter (hasVoted), appends an anonymous SHA-256
 * chained block to the ledger, increments tallies and returns a receipt.
 */
export async function POST(req: NextRequest) {
  const session = await getVoterSession(req);
  if (!session) {
    return NextResponse.json({ error: "Voting session expired. Please verify your identity again." }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const selections = body.selections ?? body.choices;
  if (!selections || typeof selections !== "object") {
    return NextResponse.json({ error: "Missing ballot selections." }, { status: 400 });
  }

  try {
    const receipt = await castBallot(session.voterId, selections);
    const res = NextResponse.json({ ok: true, ...receipt });
    res.cookies.set(BALLOT_COOKIE, "", cookieOptions(0));
    return res;
  } catch (err) {
    if (err instanceof CastError) {
      if (err.code === "ALREADY_VOTED") {
        await audit("DOUBLE_VOTE_BLOCKED", { req, severity: "warning", detail: "Blocked at ballot submission" });
      } else if (err.code === "INVALID_BALLOT") {
        await audit("INVALID_BALLOT_REJECTED", { req, severity: "critical", detail: err.message });
      }
      const res = NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
      if (err.code === "ALREADY_VOTED" || err.code === "CLOSED") res.cookies.set(BALLOT_COOKIE, "", cookieOptions(0));
      return res;
    }
    console.error("cast-vote failed:", err);
    return NextResponse.json({ error: "Your ballot could not be recorded. Nothing was saved; please try again." }, { status: 500 });
  }
}
