import { NextResponse } from "next/server";
import { BALLOT_COOKIE, BALLOT_TTL, cookieOptions, signToken } from "@/lib/session";

type VerifiedVoter = {
  _id: unknown;
  fullName: string;
  countyCode: string;
  constituencyCode: string;
  wardCode: string;
};

/** Issues the signed 30-minute ballot cookie after a biometric match. */
export async function ballotSessionResponse(voter: VerifiedVoter, body: Record<string, unknown>) {
  const token = await signToken(
    {
      role: "voter",
      voterId: String(voter._id),
      fullName: voter.fullName,
      countyCode: voter.countyCode,
      constituencyCode: voter.constituencyCode,
      wardCode: voter.wardCode,
    },
    BALLOT_TTL
  );
  const res = NextResponse.json({ ok: true, verified: true, redirect: "/ballot", ...body });
  res.cookies.set(BALLOT_COOKIE, token, cookieOptions(BALLOT_TTL));
  return res;
}
