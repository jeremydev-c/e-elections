import { NextResponse, type NextRequest } from "next/server";
import { issueChallenge } from "@/lib/livenessChallenge";
import { clientIp, lockedFor } from "@/lib/rateLimit";

/**
 * POST /api/auth/voter/liveness { idNumber }
 * Issues a fresh liveness challenge for a face login: a random order of
 * moves (turn left, turn right, blink) inside a signed, single-use token
 * that expires in 90 seconds. The face endpoint will not match a face
 * without valid evidence for it.
 */
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const idNumber = String(b.idNumber ?? "").trim();
  if (!/^\d{7,8}$/.test(idNumber)) {
    return NextResponse.json({ error: "Invalid National ID number." }, { status: 400 });
  }

  // Same locks as face verification: no new challenges while locked out.
  const wait = Math.max(lockedFor(`face:${idNumber}`), lockedFor(`face-ip:${clientIp(req)}`));
  if (wait) {
    return NextResponse.json(
      { error: `Too many failed face scans. Face Recognition is locked for ${wait}s. Try Fingerprint instead.` },
      { status: 429 }
    );
  }

  return NextResponse.json(await issueChallenge(idNumber));
}
