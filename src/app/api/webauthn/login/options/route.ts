import { NextResponse, type NextRequest } from "next/server";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { connectDB } from "@/lib/mongodb";
import { cookieOptions, signToken } from "@/lib/session";
import { getRelyingParty, WA_AUTH_COOKIE } from "@/lib/webauthn";
import { alreadyVotedMessage } from "@/lib/positions";
import { clientIp, lockedFor, recordFailure } from "@/lib/rateLimit";
import { Voter } from "@/models/Voter";

/** POST /api/webauthn/login/options { idNumber }: start fingerprint unlock passkey challenge. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  // Always coerce to a plain string: an object like {"$ne": null} must never reach the query.
  const idNumber = String(body.idNumber ?? "").trim();
  if (!/^\d{7,8}$/.test(idNumber)) return NextResponse.json({ error: "Invalid National ID." }, { status: 400 });

  const ipKey = `fp-options:${clientIp(req)}`;
  if (lockedFor(ipKey)) {
    return NextResponse.json({ error: "Too many fingerprint attempts. Wait a few minutes." }, { status: 429 });
  }
  recordFailure(ipKey, 30, 5 * 60_000);

  await connectDB();
  const voter = await Voter.findOne({ idNumber }).select("+passkeys").lean();
  if (!voter) return NextResponse.json({ error: "Voter not found." }, { status: 404 });
  if (voter.hasVoted) {
    return NextResponse.json({ error: alreadyVotedMessage(voter.idNumber, voter.votedAt), hasVoted: true }, { status: 403 });
  }

  if (!voter.passkeys || voter.passkeys.length === 0) {
    return NextResponse.json(
      { error: "No fingerprint is enrolled for this ID. Please use Face Recognition Unlock." },
      { status: 400 }
    );
  }

  const { rpID } = getRelyingParty(req);
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: voter.passkeys.map((p) => ({
      id: p.credentialId,
      transports: p.transports as AuthenticatorTransport[],
    })),
    userVerification: "required",
  });

  const res = NextResponse.json(options);
  res.cookies.set(
    WA_AUTH_COOKIE,
    await signToken({ challenge: options.challenge, voterId: String(voter._id) }, 300),
    cookieOptions(300)
  );
  return res;
}
