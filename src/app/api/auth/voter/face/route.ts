import { NextResponse, type NextRequest } from "next/server";
import { connectDB } from "@/lib/mongodb";
import {
  FACE_MATCH_THRESHOLD,
  IMPOSTOR_MARGIN,
  PROBE_CONSISTENCY_LIMIT,
  isValidSampleSet,
  matchScore,
  probeSpread,
} from "@/lib/faceMath";
import { decryptFaceTemplate } from "@/lib/biometricVault";
import { FACE_SIMILARITY_MIN, redeemLiveFace, searchFace } from "@/lib/awsFace";
import { closestTemplates, meanOf } from "@/lib/faceIndex";
import { audit } from "@/lib/audit";
import { verifyLiveness } from "@/lib/liveness";
import { redeemChallenge } from "@/lib/livenessChallenge";
import { alreadyVotedMessage } from "@/lib/positions";
import { clearFailures, clientIp, lockedFor, recordFailure } from "@/lib/rateLimit";
import { ballotSessionResponse } from "@/lib/voterSession";
import { Voter } from "@/models/Voter";
import { Election, electionStatus } from "@/models/Election";

/**
 * POST /api/auth/voter/face { idNumber, descriptors: number[3..8][128], liveness: { token, evidence } }
 * Stage 2A: matches a multi-frame live face reading against the enrolled voter.
 *
 * Accepted only if ALL of these hold:
 *   0. the liveness challenge (from /api/auth/voter/liveness) is genuine, unused,
 *      issued for this ID, and the evidence shows its moves done by this face,
 *   1. every live frame is the same face (spread < 0.55),
 *   2. the median distance to the enrolled template is < 0.45,
 *   3. no other registered voter matches as well or better (1:N check),
 * Five failures lock the ID for 5 minutes, and distances are never returned
 * on failure, so an attacker can't "hill-climb" a fake template.
 */
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const idNumber = String(b.idNumber ?? "").trim();
  const probes: unknown = b.descriptors;

  if (!/^\d{7,8}$/.test(idNumber)) {
    return NextResponse.json({ error: "Invalid National ID number." }, { status: 400 });
  }
  if (b.awsTicket !== undefined) return verifyWithAws(req, idNumber, b.awsTicket);
  if (!isValidSampleSet(probes)) {
    return NextResponse.json({ error: "Incomplete face reading. Look straight at the camera and retry." }, { status: 400 });
  }

  const key = `face:${idNumber}`;
  const ipKey = `face-ip:${clientIp(req)}`;
  const wait = Math.max(lockedFor(key), lockedFor(ipKey));
  if (wait) {
    return NextResponse.json(
      { error: `Too many failed face scans. Face Recognition is locked for ${wait}s. Try Fingerprint instead.` },
      { status: 429 }
    );
  }

  await connectDB();

  const election = await Election.findById("current").lean();
  if (election && electionStatus(election) !== "OPEN") {
    return NextResponse.json({ error: "Voting window is not open." }, { status: 403 });
  }

  const voter = await Voter.findOne({ idNumber }).select("+faceTemplate").lean();
  if (!voter) return NextResponse.json({ error: "Voter not found." }, { status: 404 });
  if (voter.hasVoted) {
    await audit("DOUBLE_VOTE_BLOCKED", { req, severity: "warning", idNumber, detail: "Blocked at face verification" });
    return NextResponse.json({ error: alreadyVotedMessage(voter.idNumber, voter.votedAt), hasVoted: true }, { status: 403 });
  }
  const template = decryptFaceTemplate(voter.faceTemplate, voter.idNumber);
  if (!template) {
    if (voter.faceTemplate) {
      await audit("FACE_MATCH_FAILED", { req, severity: "critical", idNumber, detail: "Encrypted face template failed to decrypt (tampered or swapped)" });
    }
    return NextResponse.json(
      { error: "No face template is enrolled for this ID. Use Fingerprint or visit a registration desk." },
      { status: 400 }
    );
  }

  const fail = async (error: string, reason: string, event: "FACE_MATCH_FAILED" | "LIVENESS_FAILED" = "FACE_MATCH_FAILED") => {
    recordFailure(key, 5);
    recordFailure(ipKey, 20, 10 * 60_000);
    const locked = lockedFor(key) > 0;
    await audit(locked ? "FACE_LOCKED_OUT" : event, {
      req,
      severity: locked ? "critical" : "warning",
      idNumber,
      detail: reason,
    });
    return NextResponse.json({ error }, { status: 401 });
  };

  // 0. Proof of a live person: the random moves of this login's challenge, done by this face.
  const steps = await redeemChallenge(b.liveness?.token, idNumber);
  if (!steps) {
    return fail(
      "The liveness check expired or was already used. Start the face scan again.",
      "Liveness token missing, expired, reused or for another ID",
      "LIVENESS_FAILED"
    );
  }
  const live = verifyLiveness(steps, b.liveness?.evidence, probes);
  if (!live.ok) {
    return fail(
      "We could not confirm a live person. Follow the on-screen moves (turn, blink) and retry.",
      live.reason,
      "LIVENESS_FAILED"
    );
  }

  // 1. All live frames must be one and the same face.
  if (probeSpread(probes) > PROBE_CONSISTENCY_LIMIT) {
    return fail(
      "The camera saw more than one face during the scan. Make sure only you are in view and retry.",
      "Inconsistent frames (possible face swap)"
    );
  }

  // 2. Match against the claimed voter's enrolled template.
  const score = matchScore(template, probes);
  if (score >= FACE_MATCH_THRESHOLD) {
    return fail(
      "Face did not match the registered voter. Face a light, remove glasses or hats, and retry.",
      "Face did not match the enrolled template"
    );
  }

  // 3. 1:N check: the claimed voter must be the clear best match on the register.
  //    The in-memory face index searches every enrolled voter and returns the closest few.
  const others = await closestTemplates(meanOf(probes), String(voter._id));
  const rival = others.some((o) => matchScore(o, probes) < score + IMPOSTOR_MARGIN);
  if (rival) {
    return fail(
      "This face is too close to another registered voter to confirm safely. Retry in better light.",
      "Face matched another registered voter as well or better (1:N check)"
    );
  }

  clearFailures(key);
  const confidence = Math.round(Math.max(0, 1 - score / FACE_MATCH_THRESHOLD) * 1000) / 10;
  return ballotSessionResponse(voter, { method: "face", confidence, frames: probes.length });
}

/**
 * The same login checked by AWS Rekognition (NEXT_PUBLIC_FACE_PROVIDER=aws):
 *   0. the AWS Face Liveness check for this ID passed with high confidence,
 *   1. the live face's best match on the whole register is this voter (>= 95% similar),
 *   2. no other registered voter looks similar (>= 90%).
 * Same lockouts as above; similarity scores are never returned on failure.
 */
async function verifyWithAws(req: NextRequest, idNumber: string, ticket: unknown) {
  const key = `face:${idNumber}`;
  const ipKey = `face-ip:${clientIp(req)}`;
  const wait = Math.max(lockedFor(key), lockedFor(ipKey));
  if (wait) {
    return NextResponse.json(
      { error: `Too many failed face scans. Face Recognition is locked for ${wait}s. Try Fingerprint instead.` },
      { status: 429 }
    );
  }

  await connectDB();

  const election = await Election.findById("current").lean();
  if (election && electionStatus(election) !== "OPEN") {
    return NextResponse.json({ error: "Voting window is not open." }, { status: 403 });
  }

  const voter = await Voter.findOne({ idNumber }).select("+awsFaceId").lean();
  if (!voter) return NextResponse.json({ error: "Voter not found." }, { status: 404 });
  if (voter.hasVoted) {
    await audit("DOUBLE_VOTE_BLOCKED", { req, severity: "warning", idNumber, detail: "Blocked at face verification" });
    return NextResponse.json({ error: alreadyVotedMessage(voter.idNumber, voter.votedAt), hasVoted: true }, { status: 403 });
  }
  if (!voter.awsFaceId) {
    return NextResponse.json(
      { error: "No face is enrolled for this ID. Use Fingerprint or visit a registration desk." },
      { status: 400 }
    );
  }

  const fail = async (error: string, reason: string, event: "FACE_MATCH_FAILED" | "LIVENESS_FAILED" = "FACE_MATCH_FAILED") => {
    recordFailure(key, 5);
    recordFailure(ipKey, 20, 10 * 60_000);
    const locked = lockedFor(key) > 0;
    await audit(locked ? "FACE_LOCKED_OUT" : event, { req, severity: locked ? "critical" : "warning", idNumber, detail: reason });
    return NextResponse.json({ error }, { status: 401 });
  };

  try {
    const live = await redeemLiveFace(ticket, "login", idNumber);
    if (!live.ok) {
      return fail("We could not confirm a live person. Start the face scan again and follow the screen.", live.reason, "LIVENESS_FAILED");
    }

    const matches = await searchFace(live.image);
    const best = matches[0];
    if (!best || best.faceId !== voter.awsFaceId || best.similarity < FACE_SIMILARITY_MIN) {
      return fail(
        "Face did not match the registered voter. Face a light, remove glasses or hats, and retry.",
        best && best.faceId !== voter.awsFaceId
          ? "Live face best matched another registered voter (AWS 1:N)"
          : "Face did not match the enrolled face (AWS)"
      );
    }
    if (matches.some((m) => m.voterId !== String(voter._id))) {
      return fail(
        "This face is too close to another registered voter to confirm safely. Retry in better light.",
        "Face also matched another registered voter (AWS 1:N)"
      );
    }

    clearFailures(key);
    return ballotSessionResponse(voter, {
      method: "face",
      provider: "aws",
      confidence: Math.round(best.similarity * 10) / 10,
      liveness: Math.round(live.confidence * 10) / 10,
    });
  } catch (err) {
    console.error("AWS face check failed:", (err as Error).name, (err as Error).message);
    return NextResponse.json({ error: "The face service is not responding. Try again or use Fingerprint." }, { status: 502 });
  }
}
