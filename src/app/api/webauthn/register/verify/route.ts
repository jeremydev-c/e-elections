import { NextResponse, type NextRequest } from "next/server";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { connectDB } from "@/lib/mongodb";
import { cookieOptions, getAdmin, verifyToken } from "@/lib/session";
import { getRelyingParty, WA_REG_COOKIE } from "@/lib/webauthn";
import { Voter } from "@/models/Voter";

/** POST /api/webauthn/register/verify { voterId, response }: finish passkey enrollment. */
export async function POST(req: NextRequest) {
  if (!(await getAdmin(req))) {
    return NextResponse.json({ error: "Admin login required." }, { status: 401 });
  }
  const { voterId, response } = await req.json().catch(() => ({}));
  const pending = await verifyToken<{ challenge: string; voterId: string }>(
    req.cookies.get(WA_REG_COOKIE)?.value
  );
  if (!pending || pending.voterId !== voterId) {
    return NextResponse.json({ error: "Enrollment expired. Please try again." }, { status: 400 });
  }

  const { rpID, origin } = getRelyingParty(req);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  if (!verification.verified || !verification.registrationInfo) {
    return NextResponse.json({ error: "Fingerprint enrollment could not be verified." }, { status: 400 });
  }

  const { credential } = verification.registrationInfo;
  await connectDB();
  await Voter.updateOne(
    { _id: voterId },
    {
      $set: { fingerprintCredentialId: credential.id },
      $push: {
        passkeys: {
          credentialId: credential.id,
          publicKey: isoBase64URL.fromBuffer(credential.publicKey),
          counter: credential.counter,
          transports: credential.transports ?? [],
        },
      },
    }
  );

  const res = NextResponse.json({ verified: true });
  res.cookies.set(WA_REG_COOKIE, "", cookieOptions(0));
  return res;
}
