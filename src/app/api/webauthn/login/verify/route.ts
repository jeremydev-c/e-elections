import { NextResponse, type NextRequest } from "next/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { connectDB } from "@/lib/mongodb";
import { cookieOptions, verifyToken } from "@/lib/session";
import { audit } from "@/lib/audit";
import { alreadyVotedMessage } from "@/lib/positions";
import { getRelyingParty, WA_AUTH_COOKIE } from "@/lib/webauthn";
import { ballotSessionResponse } from "@/lib/voterSession";
import { Voter } from "@/models/Voter";
import { Election, electionStatus } from "@/models/Election";

/**
 * POST /api/webauthn/login/verify { idNumber, response }
 * Stage 2B: verifies the fingerprint (WebAuthn assertion signed by the
 * device's secure enclave) and issues the ballot session.
 */
export async function POST(req: NextRequest) {
  const { idNumber, response } = await req.json().catch(() => ({}));
  const pending = await verifyToken<{ challenge: string; voterId: string }>(req.cookies.get(WA_AUTH_COOKIE)?.value);
  if (!pending) {
    return NextResponse.json({ error: "Fingerprint challenge expired. Please retry." }, { status: 400 });
  }

  await connectDB();

  const election = await Election.findById("current").lean();
  if (election && electionStatus(election) !== "OPEN") {
    return NextResponse.json({ error: "Voting window is not open." }, { status: 403 });
  }

  const voter = await Voter.findOne({ idNumber: String(idNumber ?? "") }).select("+passkeys");
  if (!voter || String(voter._id) !== pending.voterId) {
    return NextResponse.json({ error: "Voter verification failed." }, { status: 404 });
  }
  if (voter.hasVoted) {
    await audit("DOUBLE_VOTE_BLOCKED", { req, severity: "warning", idNumber: voter.idNumber, detail: "Blocked at fingerprint verification" });
    return NextResponse.json({ error: alreadyVotedMessage(voter.idNumber, voter.votedAt), hasVoted: true }, { status: 403 });
  }

  const passkey = voter.passkeys.find((p) => p.credentialId === response?.id);
  if (!passkey) {
    return NextResponse.json({ error: "This fingerprint credential is not enrolled for this voter." }, { status: 400 });
  }

  const { rpID, origin } = getRelyingParty(req);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: passkey.credentialId,
        publicKey: isoBase64URL.toBuffer(passkey.publicKey),
        counter: passkey.counter,
        transports: passkey.transports as AuthenticatorTransport[],
      },
      requireUserVerification: true,
    });
  } catch (err) {
    await audit("FINGERPRINT_FAILED", { req, severity: "warning", idNumber: voter.idNumber, detail: (err as Error).message });
    return NextResponse.json({ error: "Fingerprint verification failed. Please try again." }, { status: 400 });
  }

  if (!verification.verified || !verification.authenticationInfo) {
    await audit("FINGERPRINT_FAILED", { req, severity: "warning", idNumber: voter.idNumber, detail: "Signature not verified" });
    return NextResponse.json({ error: "Fingerprint verification failed." }, { status: 400 });
  }

  // Signature counter defeats cloned authenticators.
  await Voter.updateOne(
    { _id: voter._id, "passkeys.credentialId": passkey.credentialId },
    { $set: { "passkeys.$.counter": verification.authenticationInfo.newCounter } }
  );

  const res = await ballotSessionResponse(voter, { method: "fingerprint" });
  res.cookies.set(WA_AUTH_COOKIE, "", cookieOptions(0));
  return res;
}
