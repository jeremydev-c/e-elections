import { NextResponse, type NextRequest } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { audit } from "@/lib/audit";
import { clientIp, lockedFor, recordFailure } from "@/lib/rateLimit";
import { getConstituency, getCounty, getWard } from "@/lib/regions";
import { cardNumber, initialsName, readCardToken } from "@/lib/voterCard";
import { Voter } from "@/models/Voter";

/**
 * GET /api/card/verify?c=<token>  (public: anyone who scans a card)
 *
 * Says whether the card is genuine, replaced or forged, and shows just enough to
 * compare with the card in your hand: initials, home region, card number, issue date.
 * It never shows the National ID, phone, photo or whether the person has voted.
 */
export async function GET(req: NextRequest) {
  const ipKey = `card:${clientIp(req)}`;
  if (lockedFor(ipKey)) {
    return NextResponse.json({ error: "Too many invalid cards scanned. Try again in a few minutes." }, { status: 429 });
  }

  const token = String(new URL(req.url).searchParams.get("c") ?? "").slice(0, 120);
  const read = readCardToken(token);
  if (!read) {
    recordFailure(ipKey, 20);
    await audit("FORGED_CARD_SCANNED", { req, severity: "warning", detail: "QR signature did not match" });
    return NextResponse.json({ status: "forged" });
  }

  await connectDB();
  const voter = await Voter.findById(read.voterId, {
    fullName: 1, countyCode: 1, constituencyCode: 1, wardCode: 1, cardSerial: 1, cardIssuedAt: 1, createdAt: 1,
  }).lean();
  if (!voter) return NextResponse.json({ status: "unknown" });

  const current = voter.cardSerial ?? 1;
  return NextResponse.json({
    status: read.serial === current ? "valid" : "replaced",
    cardNumber: cardNumber(read.voterId, read.serial),
    name: initialsName(voter.fullName),
    county: getCounty(voter.countyCode)?.name ?? voter.countyCode,
    constituency: getConstituency(voter.constituencyCode)?.name ?? voter.constituencyCode,
    ward: getWard(voter.wardCode)?.name ?? voter.wardCode,
    issuedAt: read.serial === current ? (voter.cardIssuedAt ?? voter.createdAt) : undefined,
  });
}
