import { NextResponse, type NextRequest } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { audit } from "@/lib/audit";
import { getAdmin } from "@/lib/session";
import { getConstituency, getCounty, getWard, isValidRegion } from "@/lib/regions";
import { hashPassword } from "@/lib/password";
import { pinProblem } from "@/lib/pin";
import {
  FACE_MATCH_THRESHOLD,
  PROBE_CONSISTENCY_LIMIT,
  faceDistance,
  isValidDescriptor,
  isValidSampleSet,
  matchScore,
  probeSpread,
} from "@/lib/faceMath";
import { encryptFaceTemplate, encryptPhoto } from "@/lib/biometricVault";
import { closestTemplates, indexVoter } from "@/lib/faceIndex";
import { enrollFace, redeemLiveFace, removeFace, searchFace } from "@/lib/awsFace";
import { Types } from "mongoose";
import { Voter } from "@/models/Voter";

const ID_RE = /^\d{7,8}$/;
const PHONE_RE = /^(?:\+?254|0)?([17]\d{8})$/;

/**
 * GET /api/voters?idNumber=12345678
 * Pre-flight verification to check if a National ID already exists in the central register.
 */
export async function GET(req: NextRequest) {
  if (!(await getAdmin(req))) {
    return NextResponse.json({ error: "Admin login required." }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const idNumber = String(searchParams.get("idNumber") ?? "").trim();

  if (!idNumber) {
    return NextResponse.json({ error: "Missing idNumber parameter." }, { status: 400 });
  }

  if (!ID_RE.test(idNumber)) {
    return NextResponse.json({ error: "National ID must be 7–8 digits." }, { status: 400 });
  }

  await connectDB();

  const existing = await Voter.findOne(
    { idNumber },
    { fullName: 1, idNumber: 1, countyCode: 1, constituencyCode: 1, wardCode: 1, createdAt: 1 }
  ).lean();

  if (!existing) {
    return NextResponse.json({ exists: false, idNumber });
  }

  return NextResponse.json({
    exists: true,
    voter: {
      fullName: existing.fullName,
      idNumber: existing.idNumber,
      countyCode: existing.countyCode,
      constituencyCode: existing.constituencyCode,
      wardCode: existing.wardCode,
      registeredAt: existing.createdAt,
    },
  });
}

/** POST /api/voters: register a voter (admin only). */
export async function POST(req: NextRequest) {
  const admin = await getAdmin(req);
  if (!admin) {
    return NextResponse.json({ error: "Admin login required." }, { status: 401 });
  }

  const b = await req.json().catch(() => ({}));
  const idNumber = String(b.idNumber ?? "").trim();
  const fullName = String(b.fullName ?? "").trim().replace(/\s+/g, " ");
  const phoneMatch = String(b.phone ?? "").replace(/[\s-]/g, "").match(PHONE_RE);
  const { countyCode, constituencyCode, wardCode, faceDescriptor, faceSamples, photoDataUrl } = b;
  const pin = String(b.pin ?? "");
  const viaAws = b.awsTicket !== undefined;

  const errors: string[] = [];
  if (!ID_RE.test(idNumber)) errors.push("National ID must be 7–8 digits.");
  if (fullName.length < 3 || fullName.length > 100) errors.push("Enter the voter's full name.");
  if (!phoneMatch) errors.push("Enter a valid Kenyan phone number (e.g. 0712 345 678).");
  if (!isValidRegion(String(countyCode), String(constituencyCode), String(wardCode)))
    errors.push("Select a valid County, Constituency and Ward.");
  if (viaAws) {
    if (typeof b.awsTicket !== "string") errors.push("A completed face scan is required.");
  } else if (!isValidDescriptor(faceDescriptor) || !isValidSampleSet(faceSamples)) {
    errors.push("A complete multi-frame face scan is required.");
  } else if (
    probeSpread(faceSamples) > PROBE_CONSISTENCY_LIMIT ||
    faceSamples.some((s) => faceDistance(s, faceDescriptor) > 0.4)
  ) {
    errors.push("The face scan was inconsistent (more than one face?). Please rescan.");
  }
  // USSD PIN is optional until the *2027# feature launches.
  const pinError = pin ? pinProblem(pin) : null;
  if (pinError) errors.push(pinError);
  if (errors.length) return NextResponse.json({ error: errors.join(" ") }, { status: 400 });

  await connectDB();

  if (await Voter.exists({ idNumber })) {
    return NextResponse.json({ error: "This National ID is already registered." }, { status: 409 });
  }

  if (viaAws) {
    return registerWithAws(req, admin.username, b.awsTicket, {
      idNumber,
      fullName,
      phone: `+254${phoneMatch![1]}`,
      countyCode,
      constituencyCode,
      wardCode,
      pin,
    });
  }

  // One person, one registration: reject a face that is already enrolled
  // under a different ID number (checked against the closest faces on the whole register).
  const nearest = await closestTemplates(faceDescriptor);
  const duplicate = nearest.some((t) => matchScore(t, faceSamples) < FACE_MATCH_THRESHOLD);
  if (duplicate) {
    await audit("DUPLICATE_FACE_BLOCKED", { req, severity: "warning", actor: admin.username, idNumber, detail: "Face already enrolled under another ID" });
    return NextResponse.json(
      { error: "This face is already registered under another National ID." },
      { status: 409 }
    );
  }

  try {
    const photoOk =
      typeof photoDataUrl === "string" && photoDataUrl.startsWith("data:image/") && photoDataUrl.length < 300_000;
    const voter = await Voter.create({
      idNumber,
      fullName,
      phone: `+254${phoneMatch![1]}`,
      county: getCounty(countyCode)!.name,
      constituency: getConstituency(constituencyCode)!.name,
      ward: getWard(wardCode)!.name,
      countyCode,
      constituencyCode,
      wardCode,
      faceTemplate: encryptFaceTemplate({ mean: faceDescriptor, samples: faceSamples }, idNumber),
      photoEnc: photoOk ? encryptPhoto(photoDataUrl, idNumber) : undefined,
      ussdPinHash: pin ? await hashPassword(pin) : undefined,
    });
    indexVoter(String(voter._id), faceDescriptor);
    await audit("VOTER_REGISTERED", { req, actor: admin.username, idNumber, detail: `${voter.ward} Ward, ${voter.county}` });
    return NextResponse.json(
      {
        voterId: String(voter._id),
        fullName,
        idNumber,
        phone: voter.phone,
        countyCode,
        constituencyCode,
        wardCode,
        photoDataUrl: photoOk ? photoDataUrl : undefined,
      },
      { status: 201 }
    );
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      return NextResponse.json({ error: "This National ID is already registered." }, { status: 409 });
    }
    throw err;
  }
}

type NewVoter = {
  idNumber: string;
  fullName: string;
  phone: string;
  countyCode: string;
  constituencyCode: string;
  wardCode: string;
  pin: string;
};

/**
 * Registration with the face checked by AWS Rekognition (NEXT_PUBLIC_FACE_PROVIDER=aws):
 * the official's AWS Face Liveness check must have passed, the face must not
 * already be on the register, and it is then added to the AWS collection.
 */
async function registerWithAws(req: NextRequest, officialUsername: string, ticket: string, v: NewVoter) {
  let faceId: string | null = null;
  try {
    const live = await redeemLiveFace(ticket, "enroll", officialUsername);
    if (!live.ok) {
      await audit("LIVENESS_FAILED", { req, severity: "warning", actor: officialUsername, idNumber: v.idNumber, detail: live.reason });
      return NextResponse.json({ error: "The face scan did not confirm a live person. Please rescan." }, { status: 400 });
    }

    // One person, one registration, checked against every face on the register.
    if ((await searchFace(live.image)).length) {
      await audit("DUPLICATE_FACE_BLOCKED", { req, severity: "warning", actor: officialUsername, idNumber: v.idNumber, detail: "Face already enrolled under another ID (AWS)" });
      return NextResponse.json({ error: "This face is already registered under another National ID." }, { status: 409 });
    }

    const voterId = new Types.ObjectId();
    faceId = await enrollFace(live.image, String(voterId));
    if (!faceId) {
      return NextResponse.json({ error: "The photo was not clear enough to enrol. Rescan in good light." }, { status: 400 });
    }

    const photoDataUrl = `data:image/jpeg;base64,${Buffer.from(live.image).toString("base64")}`;
    const photoOk = photoDataUrl.length < 300_000;
    const voter = await Voter.create({
      _id: voterId,
      idNumber: v.idNumber,
      fullName: v.fullName,
      phone: v.phone,
      county: getCounty(v.countyCode)!.name,
      constituency: getConstituency(v.constituencyCode)!.name,
      ward: getWard(v.wardCode)!.name,
      countyCode: v.countyCode,
      constituencyCode: v.constituencyCode,
      wardCode: v.wardCode,
      awsFaceId: faceId,
      photoEnc: photoOk ? encryptPhoto(photoDataUrl, v.idNumber) : undefined,
      ussdPinHash: v.pin ? await hashPassword(v.pin) : undefined,
    });
    await audit("VOTER_REGISTERED", { req, actor: officialUsername, idNumber: v.idNumber, detail: `${voter.ward} Ward, ${voter.county} (AWS face)` });
    return NextResponse.json(
      {
        voterId: String(voter._id),
        fullName: v.fullName,
        idNumber: v.idNumber,
        phone: voter.phone,
        countyCode: v.countyCode,
        constituencyCode: v.constituencyCode,
        wardCode: v.wardCode,
        photoDataUrl: photoOk ? photoDataUrl : undefined,
      },
      { status: 201 }
    );
  } catch (err) {
    // Never leave a face in AWS without a voter record behind it.
    if (faceId) await removeFace(faceId).catch(() => {});
    if ((err as { code?: number }).code === 11000) {
      return NextResponse.json({ error: "This National ID is already registered." }, { status: 409 });
    }
    console.error("AWS registration failed:", (err as Error).name, (err as Error).message);
    return NextResponse.json({ error: "The face service is not responding. Try again in a moment." }, { status: 502 });
  }
}
