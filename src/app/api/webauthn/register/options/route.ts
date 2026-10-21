import { NextResponse, type NextRequest } from "next/server";
import { isValidObjectId } from "mongoose";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { isoUint8Array } from "@simplewebauthn/server/helpers";
import { connectDB } from "@/lib/mongodb";
import { cookieOptions, getAdmin, signToken } from "@/lib/session";
import { getRelyingParty, WA_REG_COOKIE } from "@/lib/webauthn";
import { Voter } from "@/models/Voter";

/**
 * POST /api/webauthn/register/options { voterId, attachment? }: start fingerprint enrollment (admin only).
 * attachment "platform" (default) = this device's built-in fingerprint / Windows Hello sensor.
 * attachment "any" = fallback for devices without one: the browser offers a phone (scan QR) or USB key.
 */
export async function POST(req: NextRequest) {
  if (!(await getAdmin(req))) {
    return NextResponse.json({ error: "Admin login required." }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const voterId = String(body.voterId ?? "");
  const attachment = body.attachment === "any" ? "any" : "platform";
  if (!isValidObjectId(voterId)) return NextResponse.json({ error: "Invalid voter." }, { status: 400 });

  await connectDB();
  const voter = await Voter.findById(voterId).select("+passkeys").catch(() => null);
  if (!voter) return NextResponse.json({ error: "Voter not found." }, { status: 404 });

  const { rpName, rpID } = getRelyingParty(req);
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: voter.idNumber,
    userDisplayName: voter.fullName,
    userID: isoUint8Array.fromUTF8String(String(voter._id)),
    attestationType: "none",
    excludeCredentials: voter.passkeys.map((p) => ({
      id: p.credentialId,
      transports: p.transports as AuthenticatorTransport[],
    })),
    authenticatorSelection: {
      ...(attachment !== "any" && { authenticatorAttachment: "platform" as const }),
      residentKey: "preferred",
      userVerification: "required", // must actually scan the finger
    },
  });

  const res = NextResponse.json(options);
  res.cookies.set(
    WA_REG_COOKIE,
    await signToken({ challenge: options.challenge, voterId: String(voter._id) }, 300),
    cookieOptions(300)
  );
  return res;
}
