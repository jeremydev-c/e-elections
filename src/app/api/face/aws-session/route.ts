import { NextResponse, type NextRequest } from "next/server";
import { FACE_PROVIDER, awsConfigured, startLivenessSession } from "@/lib/awsFace";
import { clientIp, lockedFor, recordFailure } from "@/lib/rateLimit";
import { getAdmin } from "@/lib/session";

/**
 * POST /api/face/aws-session { purpose: "login", idNumber } | { purpose: "enroll" }
 * Starts an AWS Face Liveness check for one voter login, or for one
 * registration by a signed-in official. Each check costs money, so every
 * IP address may start at most 30 per 10 minutes.
 */
export async function POST(req: NextRequest) {
  if (FACE_PROVIDER !== "aws" || !awsConfigured()) {
    return NextResponse.json({ error: "AWS face scanning is not switched on." }, { status: 503 });
  }

  const b = await req.json().catch(() => ({}));
  const purpose = b.purpose === "enroll" ? "enroll" : "login";
  const ip = clientIp(req);

  let subject: string;
  if (purpose === "enroll") {
    const admin = await getAdmin(req);
    if (!admin) return NextResponse.json({ error: "Admin login required." }, { status: 401 });
    subject = admin.username;
  } else {
    subject = String(b.idNumber ?? "").trim();
    if (!/^\d{7,8}$/.test(subject)) {
      return NextResponse.json({ error: "Invalid National ID number." }, { status: 400 });
    }
    // Same locks as face verification: no new scans while locked out.
    const wait = Math.max(lockedFor(`face:${subject}`), lockedFor(`face-ip:${ip}`));
    if (wait) {
      return NextResponse.json(
        { error: `Too many failed face scans. Face Recognition is locked for ${wait}s. Try Fingerprint instead.` },
        { status: 429 }
      );
    }
  }

  const rateKey = `aws-session:${ip}`;
  const wait = lockedFor(rateKey);
  if (wait) {
    return NextResponse.json({ error: `Too many face scans from this device. Try again in ${wait}s.` }, { status: 429 });
  }
  recordFailure(rateKey, 30, 10 * 60_000);

  try {
    return NextResponse.json(await startLivenessSession(purpose, subject));
  } catch (err) {
    console.error("AWS liveness session failed:", (err as Error).name, (err as Error).message);
    return NextResponse.json({ error: "Could not start the face scan. Try again in a moment." }, { status: 502 });
  }
}
