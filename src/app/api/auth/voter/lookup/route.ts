import { NextResponse, type NextRequest } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { audit } from "@/lib/audit";
import { maskName } from "@/lib/pin";
import { alreadyVotedMessage } from "@/lib/positions";
import { clientIp, lockedFor, recordFailure } from "@/lib/rateLimit";
import { Voter } from "@/models/Voter";
import { Election, electionStatus } from "@/models/Election";

const ID_RE = /^\d{7,8}$/;

/**
 * POST /api/auth/voter/lookup { idNumber }
 * Stage 1 of voter login: is this ID registered, is the window open, and
 * has it already voted? Returns only a masked name (no photo, no phone)
 * so the endpoint cannot be used to harvest voter identities.
 */
export async function POST(req: NextRequest) {
  const ipKey = `lookup:${clientIp(req)}`;
  const wait = lockedFor(ipKey);
  if (wait) {
    return NextResponse.json({ error: `Too many unknown ID lookups. Try again in ${wait}s.` }, { status: 429 });
  }

  const b = await req.json().catch(() => ({}));
  const idNumber = String(b.idNumber ?? "").trim();
  if (!ID_RE.test(idNumber)) {
    return NextResponse.json({ error: "National ID must be 7–8 digits." }, { status: 400 });
  }

  await connectDB();

  const election = await Election.findById("current").lean();
  if (election && electionStatus(election) !== "OPEN") {
    const status = electionStatus(election);
    return NextResponse.json(
      {
        error:
          status === "UPCOMING"
            ? "The election voting window has not opened yet."
            : "The election voting window has officially closed.",
      },
      { status: 403 }
    );
  }

  const voter = await Voter.findOne({ idNumber })
    .select("+passkeys +faceTemplate +awsFaceId")
    .lean();

  if (!voter) {
    recordFailure(ipKey, 10);
    return NextResponse.json(
      { error: "This National ID is not in the voter register. Please register at an official desk first." },
      { status: 404 }
    );
  }

  // Single-vote lockout (double voting prevention, stage 1).
  if (voter.hasVoted) {
    await audit("DOUBLE_VOTE_BLOCKED", { req, severity: "warning", idNumber, detail: "Blocked at ID check" });
    return NextResponse.json(
      {
        hasVoted: true,
        votedAt: voter.votedAt ?? null,
        error: alreadyVotedMessage(voter.idNumber, voter.votedAt),
      },
      { status: 403 }
    );
  }

  return NextResponse.json({
    ok: true,
    voter: {
      idNumber: voter.idNumber,
      displayName: maskName(voter.fullName),
      county: voter.county,
      constituency: voter.constituency,
      ward: voter.ward,
      countyCode: voter.countyCode,
      constituencyCode: voter.constituencyCode,
      wardCode: voter.wardCode,
      hasFace: !!(voter.faceTemplate || voter.awsFaceId),
      // Which engine enrolled this face: the login page opens the matching scanner.
      faceProvider: voter.awsFaceId ? "aws" : voter.faceTemplate ? "local" : null,
      hasPasskey: Array.isArray(voter.passkeys) && voter.passkeys.length > 0,
    },
  });
}
