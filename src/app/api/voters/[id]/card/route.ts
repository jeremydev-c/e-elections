import { NextResponse, type NextRequest } from "next/server";
import QRCode from "qrcode";
import { Types } from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { audit } from "@/lib/audit";
import { getAdmin } from "@/lib/session";
import { getConstituency, getCounty, getWard } from "@/lib/regions";
import { cardNumber, cardToken } from "@/lib/voterCard";
import { Voter } from "@/models/Voter";

/** Where a scanned QR code should open: the pinned public address, else this request's own. */
function siteOrigin(req: NextRequest): string {
  const pinned = process.env.APP_ORIGIN;
  if (pinned) return new URL(pinned).origin;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * GET /api/voters/:id/card  (officials only)
 * Everything needed to print a voter's card: the card number, the signed QR code
 * and the home region. The photo is not returned; the registration desk already has it.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await getAdmin(req);
  if (!admin) return NextResponse.json({ error: "Admin login required." }, { status: 401 });

  const { id } = await params;
  if (!Types.ObjectId.isValid(id)) return NextResponse.json({ error: "Unknown voter." }, { status: 404 });

  await connectDB();
  const voter = await Voter.findById(id, {
    fullName: 1, idNumber: 1, countyCode: 1, constituencyCode: 1, wardCode: 1,
    fingerprintCredentialId: 1, cardSerial: 1, cardIssuedAt: 1, createdAt: 1,
  }).lean();
  if (!voter) return NextResponse.json({ error: "Unknown voter." }, { status: 404 });

  const serial = voter.cardSerial ?? 1;
  const issuedAt = voter.cardIssuedAt ?? voter.createdAt ?? new Date();
  const voterId = String(voter._id);
  const number = cardNumber(voterId, serial);
  const url = `${siteOrigin(req)}/card?c=${cardToken(voterId, serial)}`;
  // The QR code as one SVG path on an N x N grid, so the card can draw it at any size.
  const svg = await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 0, color: { dark: "#13150f", light: "#0000" } });
  const qr = { size: Number(/viewBox="0 0 (\d+) /.exec(svg)?.[1] ?? 0), path: /\sd="([^"]+)"/.exec(svg)?.[1] ?? "" };

  await audit("VOTER_CARD_PRINTED", { req, actor: admin.username, idNumber: voter.idNumber, detail: `Card ${number}` });

  return NextResponse.json({
    cardNumber: number,
    serial,
    issuedAt,
    url,
    qr,
    fullName: voter.fullName,
    idNumber: voter.idNumber,
    county: getCounty(voter.countyCode)?.name ?? voter.countyCode,
    constituency: getConstituency(voter.constituencyCode)?.name ?? voter.constituencyCode,
    ward: getWard(voter.wardCode)?.name ?? voter.wardCode,
    fingerprint: !!voter.fingerprintCredentialId,
  });
}
