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

  const errors: string[] = [];
  if (!ID_RE.test(idNumber)) errors.push("National ID must be 7–8 digits.");
  if (fullName.length < 3 || fullName.length > 100) errors.push("Enter the voter's full name.");
  if (!phoneMatch) errors.push("Enter a valid Kenyan phone number (e.g. 0712 345 678).");
  if (!isValidRegion(String(countyCode), String(constituencyCode), String(wardCode)))
    errors.push("Select a valid County, Constituency and Ward.");
  if (!isValidDescriptor(faceDescriptor) || !isValidSampleSet(faceSamples)) {
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
