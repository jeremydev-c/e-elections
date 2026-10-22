import { after, NextResponse, type NextRequest } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { FACE_MATCH_MIN, LEARN_MIN, RIVAL_MARGIN, learnFrame, templateSimilarity } from "@/lib/faceMath";
import { decryptFaceTemplate, encryptFaceTemplate, type FaceTemplateData } from "@/lib/biometricVault";
import { FACE_SIMILARITY_MIN, redeemLiveFace, searchFace } from "@/lib/awsFace";
import { faceModelsInstalled } from "@/lib/faceEngine";
import { closestTemplates, faceIndex, isCurrentTemplate } from "@/lib/faceIndex";
import { SCAN_MESSAGES, analyseScan, type ScanProblem } from "@/lib/faceScan";
import { audit } from "@/lib/audit";
import { redeemChallenge } from "@/lib/livenessChallenge";
import { alreadyVotedMessage } from "@/lib/positions";
import { clearFailures, clientIp, lockedFor, recordFailure } from "@/lib/rateLimit";
import { ballotSessionResponse } from "@/lib/voterSession";
import { Voter } from "@/models/Voter";
import { Election, electionStatus } from "@/models/Election";

/** Scan problems that are the voter's camera or light, not a failed identity check. */
const QUALITY: ScanProblem[] = ["BAD_FRAMES", "NO_FACE", "TOO_SMALL", "NOT_FRONTAL", "BLURRY", "TOO_DARK", "TOO_BRIGHT"];
/** Scan problems that mean the liveness check failed. */
const NOT_LIVE: ScanProblem[] = ["MOVE_NOT_DONE", "DIFFERENT_PEOPLE", "SPOOF", "MULTIPLE_FACES"];

/**
 * POST /api/auth/voter/face { idNumber, liveness: { token }, frames: [{ role, image }] }
 * Stage 2A: face login, checked entirely on the server (lib/faceScan.ts).
 *
 * Accepted only if ALL of these hold:
 *   0. the liveness challenge (from /api/auth/voter/liveness) is genuine, unused and
 *      issued for this ID, and the camera frames show its moves (turns, blink) done
 *      by one and the same live person,
 *   1. the face matches the voter's enrolled template (cosine similarity >= 0.40),
 *   2. no other registered voter comes within 0.08 of that score (1:N check).
 * Five failures lock the ID for 5 minutes, and scores are never returned on failure,
 * so an attacker can't "hill-climb" toward a template. Camera problems (dark, blurred,
 * too far) don't count toward the lock, only toward a per-device limit.
 */
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const idNumber = String(b.idNumber ?? "").trim();

  if (!/^\d{7,8}$/.test(idNumber)) {
    return NextResponse.json({ error: "Invalid National ID number." }, { status: 400 });
  }
  if (b.awsTicket !== undefined) return verifyWithAws(req, idNumber, b.awsTicket);
  if (!Array.isArray(b.frames)) {
    return NextResponse.json({ error: "Incomplete face scan. Start the scan again." }, { status: 400 });
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
  if (!faceModelsInstalled()) {
    return NextResponse.json({ error: "Face recognition is not set up on this server. Use Fingerprint." }, { status: 503 });
  }

  const t0 = performance.now();
  const lap = () => Math.round(performance.now() - t0);
  await connectDB();

  // The database (far away on Atlas) and the face engine (local) work at the same time:
  // read the voter and warm the face index while the frames are being checked.
  const records = Promise.all([
    Election.findById("current").lean(),
    Voter.findOne({ idNumber }).select("+faceTemplate").lean(),
  ]);
  void faceIndex().catch(() => {});
  const stepsP = redeemChallenge(b.liveness?.token, idNumber);
  const scanP = stepsP.then((steps) => (steps ? analyseScan(b.frames, steps) : null));
  scanP.catch(() => {}); // awaited below; don't report it as unhandled if we return early

  const [election, voter] = await records;
  const dbMs = lap();
  if (election && electionStatus(election) !== "OPEN") {
    return NextResponse.json({ error: "Voting window is not open." }, { status: 403 });
  }
  if (!voter) {
    recordFailure(ipKey, 20, 10 * 60_000);
    return NextResponse.json({ error: "Voter not found." }, { status: 404 });
  }
  if (voter.hasVoted) {
    await audit("DOUBLE_VOTE_BLOCKED", { req, severity: "warning", idNumber, detail: "Blocked at face verification" });
    return NextResponse.json({ error: alreadyVotedMessage(voter.idNumber, voter.votedAt), hasVoted: true }, { status: 403 });
  }
  const template = decryptFaceTemplate(voter.faceTemplate, voter.idNumber);
  if (!isCurrentTemplate(template)) {
    if (voter.faceTemplate && !template) {
      await audit("FACE_MATCH_FAILED", { req, severity: "critical", idNumber, detail: "Encrypted face template failed to decrypt (tampered or swapped)" });
    }
    return NextResponse.json(
      { error: "No face is enrolled for this ID with the current face system. Use Fingerprint or visit a registration desk." },
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

  // 0. The challenge, and the frames that prove its moves.
  if (!(await stepsP)) {
    return fail(
      "The liveness check expired or was already used. Start the face scan again.",
      "Liveness token missing, expired, reused or for another ID",
      "LIVENESS_FAILED"
    );
  }
  const scan = (await scanP)!;
  const scanMs = lap();
  if (!scan.ok) {
    if (QUALITY.includes(scan.problem)) {
      recordFailure(ipKey, 20, 10 * 60_000);
      return NextResponse.json({ error: SCAN_MESSAGES[scan.problem], problem: scan.problem }, { status: 400 });
    }
    return fail(SCAN_MESSAGES[scan.problem], scan.detail, NOT_LIVE.includes(scan.problem) ? "LIVENESS_FAILED" : "FACE_MATCH_FAILED");
  }

  // 1. The claimed voter.
  const score = templateSimilarity(template, scan.embedding);
  if (score < FACE_MATCH_MIN) {
    return fail(
      "Face did not match the registered voter. Face a light, remove glasses or hats, and retry.",
      `Face did not match the enrolled template (live ${scan.stats.liveScore})`
    );
  }

  // 2. 1:N: nobody else on the register may come close (the in-memory index finds the nearest few).
  const others = await closestTemplates(scan.embedding, { excludeId: String(voter._id) });
  const rivalAt = Math.max(score - RIVAL_MARGIN, FACE_MATCH_MIN - 0.1);
  if (others.some((o) => isCurrentTemplate(o) && templateSimilarity(o, scan.embedding) >= rivalAt)) {
    return fail(
      "This face is too close to another registered voter to confirm safely. Retry in better light.",
      "Face matched another registered voter almost as well (1:N check)"
    );
  }

  clearFailures(key);
  // 3. After the reply: a confident match teaches the template this face in today's light.
  if (score >= LEARN_MIN) after(() => learn(voter._id, voter.idNumber, voter.faceTemplate!, template, scan.embedding));
  const timings = { databaseMs: dbMs, faceEngineMs: scan.stats.ms, scanReadyMs: scanMs, totalMs: lap() };
  if (process.env.NODE_ENV !== "production") console.info("face login", { score: Math.round(score * 1000) / 1000, ...scan.stats, ...timings });
  return ballotSessionResponse(voter, {
    method: "face",
    confidence: Math.round(score * 1000) / 10,
    timings,
  });
}

/** Saves the learned frame, unless the template changed meanwhile (then this one is skipped). */
async function learn(voterId: unknown, idNumber: string, oldBlob: string, template: FaceTemplateData, probe: number[]) {
  try {
    const updated = learnFrame(template, probe);
    await Voter.updateOne({ _id: voterId, faceTemplate: oldBlob }, { $set: { faceTemplate: encryptFaceTemplate(updated, idNumber) } });
  } catch (err) {
    console.error("Learning the face template failed:", (err as Error).message);
  }
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
