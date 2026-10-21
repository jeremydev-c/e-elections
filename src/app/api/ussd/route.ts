import { type NextRequest } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { verifyPassword } from "@/lib/password";
import { castBallot, CastError } from "@/lib/castVote";
import { computeBallotHash, sealBallot, sealMatches } from "@/lib/hashChain";
import { loadLedger, normalizeBlock, tallyFromLedger } from "@/lib/ledger";
import { POSITIONS, alreadyVotedMessage, regionCodeFor, type Position } from "@/lib/positions";
import { clearFailures, lockedFor, recordFailure } from "@/lib/rateLimit";
import { Voter } from "@/models/Voter";
import { Candidate } from "@/models/Candidate";
import { VoteLedger } from "@/models/VoteLedger";

/**
 * POST /api/ussd  —  *2027# feature-phone voting gateway.
 *
 * Speaks the Africa's Talking USSD protocol: form fields `sessionId`,
 * `serviceCode`, `phoneNumber` and `text` (every input so far, joined
 * by "*"); the reply is plain text starting with "CON" (keep the session
 * open) or "END" (hang up). The /ussd page is a simulator for it, and
 * the same URL can be pointed at a real Africa's Talking USSD code.
 *
 * Security: SIM-bound (caller's phone number must match the register)
 * + 4-digit PIN, 3 wrong PINs lock the ID for 10 minutes, and the ballot
 * goes through the same atomic castBallot() as the web ballot.
 */

const SHORT: Record<Position, string> = {
  PRESIDENT: "President",
  GOVERNOR: "Governor",
  SENATOR: "Senator",
  WOMAN_REP: "Woman Rep",
  MP: "MP",
  MCA: "MCA",
};

const con = (s: string) => reply(`CON ${s}`);
const end = (s: string) => reply(`END ${s}`);
function reply(body: string) {
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

function normalizePhone(p: string): string | null {
  const m = p.replace(/[\s-]/g, "").match(/^(?:\+?254|0)?([17]\d{8})$/);
  return m ? `+254${m[1]}` : null;
}

const partyAbbr = (party: string) =>
  party === "Independent" ? "IND" : party.split(/\s+/).filter((w) => /^[A-Z]/.test(w)).map((w) => w[0]).join("");

const shortName = (name: string) => {
  const parts = name.split(/\s+/);
  return parts.length > 2 ? `${parts[0]} ${parts[parts.length - 1]}` : name;
};

async function readInput(req: NextRequest) {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const b = await req.json().catch(() => ({}));
    return { phoneNumber: String(b.phoneNumber ?? ""), text: String(b.text ?? "") };
  }
  const f = await req.formData().catch(() => null);
  return { phoneNumber: String(f?.get("phoneNumber") ?? ""), text: String(f?.get("text") ?? "") };
}

export async function POST(req: NextRequest) {
  const { phoneNumber, text } = await readInput(req);
  const inputs = text === "" ? [] : text.split("*").map((s) => s.trim());
  const phone = normalizePhone(phoneNumber);

  if (inputs.length === 0) {
    return con(
      "Karibu E-ELECTIONS KE 2027\n1. Vote (Piga Kura)\n2. Verify vote receipt\n3. Presidential results\n4. Check my registration"
    );
  }

  try {
    await connectDB();
    switch (inputs[0]) {
      case "1":
        return await voteFlow(inputs.slice(1), phone);
      case "2":
        return await receiptFlow(inputs.slice(1));
      case "3":
        return await resultsFlow();
      case "4":
        return await registrationFlow(inputs.slice(1), phone);
      default:
        return end("Invalid choice. Dial *2027# to start again.");
    }
  } catch (err) {
    console.error("USSD error:", err);
    return end("Service temporarily unavailable. Please try again shortly.");
  }
}

/** Finds the voter for this SIM + ID, or explains why not. */
async function findVoter(idNumber: string, phone: string | null) {
  if (!/^\d{7,8}$/.test(idNumber)) return { error: "Invalid ID number. Dial *2027# to try again." };
  const voter = await Voter.findOne({ idNumber }).select("+ussdPinHash").lean();
  // Same message for "no such ID" and "wrong SIM" so IDs can't be probed.
  if (!voter || !phone || voter.phone !== phone) {
    return { error: "This SIM card and ID number do not match the voter register." };
  }
  return { voter };
}

async function voteFlow(rest: string[], phone: string | null) {
  const [idNumber, pin, ...picks] = rest;
  if (idNumber === undefined) return con("Enter your National ID number:");

  const { voter, error } = await findVoter(idNumber, phone);
  if (!voter) return end(error);
  if (voter.hasVoted) return end(alreadyVotedMessage(voter.idNumber, voter.votedAt));
  if (!voter.ussdPinHash) return end("No USSD PIN is set for this voter. Visit a registration desk.");

  if (pin === undefined) return con("Enter your 4-digit voting PIN:");

  const key = `ussd-pin:${voter.idNumber}`;
  const wait = lockedFor(key);
  if (wait) return end(`Too many wrong PINs. USSD voting is locked for ${Math.ceil(wait / 60)} min.`);
  if (!(await verifyPassword(pin, voter.ussdPinHash))) {
    recordFailure(key, 3, 10 * 60_000);
    return end("Wrong PIN. 3 wrong attempts lock your ID for 10 minutes.");
  }
  clearFailures(key);

  // Candidates for each of the 6 seats on THIS voter's ballot, in a fixed order.
  const candidates = await Candidate.find({
    $or: POSITIONS.map((p) => ({ position: p, regionCode: regionCodeFor(p, voter) })),
  })
    .select("name party position county constituency ward")
    .sort({ party: 1, name: 1, _id: 1 })
    .lean();
  const bySeat = new Map(POSITIONS.map((p) => [p, candidates.filter((c) => c.position === p)]));

  // Walk the inputs seat by seat. An invalid key press is ignored and the
  // same seat is shown again (the USSD text keeps every key press).
  const chosen: { position: Position; id: string; name: string }[] = [];
  let lastInvalid = false;
  let i = 0;
  for (; i < picks.length && chosen.length < POSITIONS.length; i++) {
    const seat = POSITIONS[chosen.length];
    const list = bySeat.get(seat) ?? [];
    const n = Number(picks[i]);
    if (Number.isInteger(n) && n >= 1 && n <= list.length) {
      chosen.push({ position: seat, id: String(list[n - 1]._id), name: list[n - 1].name });
      lastInvalid = false;
    } else {
      lastInvalid = true;
    }
  }

  if (chosen.length < POSITIONS.length) {
    const seat = POSITIONS[chosen.length];
    const list = bySeat.get(seat) ?? [];
    if (list.length === 0) return end(`No ${SHORT[seat]} candidates found for your region. Contact the IEBC.`);
    const where = list[0].ward ?? list[0].constituency ?? list[0].county ?? "Kenya";
    const lines = list.map((c, idx) => `${idx + 1}. ${shortName(c.name)} (${partyAbbr(c.party)})`);
    return con(
      `${lastInvalid ? "Invalid choice. " : ""}[${chosen.length + 1}/6] ${SHORT[seat].toUpperCase()} - ${where}\n${lines.join("\n")}`
    );
  }

  const confirm = picks[i];
  if (confirm === undefined) {
    const summary = chosen.map((c) => `${SHORT[c.position]}: ${shortName(c.name)}`).join("\n");
    return con(`Confirm ballot:\n${summary}\n1. CAST VOTE\n2. Cancel`);
  }
  if (confirm !== "1") return end("Ballot cancelled. Nothing was recorded. Dial *2027# to vote.");

  try {
    const receipt = await castBallot(
      String(voter._id),
      Object.fromEntries(chosen.map((c) => [c.position, c.id]))
    );
    return end(
      `VOTE CAST! Asante.\nReceipt: ${receipt.receiptCode}\nBlock #${receipt.seq} SHA-256 ${receipt.currentHash.slice(0, 12)}...\nVerify: dial *2027# > 2`
    );
  } catch (err) {
    if (err instanceof CastError) return end(err.message);
    throw err;
  }
}

async function receiptFlow([code]: string[]) {
  if (code === undefined) return con("Enter your receipt code\n(e.g. KE-2027-8F9A-K7QX):");
  const receiptCode = code.toUpperCase().replace(/\s+/g, "");
  const raw = await VoteLedger.findOne({ receiptCode }).lean();
  if (!raw) return end(`Receipt ${receiptCode} was NOT found in the ledger.`);
  const block = normalizeBlock(raw);
  const ok = computeBallotHash(block) === block.currentHash && sealMatches(sealBallot(block.currentHash), block.seal);
  return end(
    ok
      ? `RECEIPT VERIFIED\n${receiptCode}\nBlock #${block.seq}, SHA-256 seal intact\n${block.currentHash.slice(0, 16)}...`
      : `WARNING: Receipt ${receiptCode} exists but its SHA-256 seal is BROKEN. Report to IEBC.`
  );
}

async function resultsFlow() {
  const [blocks, pres] = await Promise.all([
    loadLedger(),
    Candidate.find({ position: "PRESIDENT" }, { name: 1, party: 1 }).lean(),
  ]);
  const tally = tallyFromLedger(blocks);
  const rows = pres
    .map((c) => ({ name: shortName(c.name), party: partyAbbr(c.party), votes: tally.get(String(c._id)) ?? 0 }))
    .sort((a, z) => z.votes - a.votes);
  const total = rows.reduce((s, r) => s + r.votes, 0);
  const lines = rows.map(
    (r) => `${r.name} (${r.party}): ${r.votes} (${total ? Math.round((r.votes / total) * 1000) / 10 : 0}%)`
  );
  return end(`PRESIDENT - LIVE\n${lines.join("\n")}\nTotal: ${total} votes`);
}

async function registrationFlow([idNumber]: string[], phone: string | null) {
  if (idNumber === undefined) return con("Enter your National ID number:");
  const { voter, error } = await findVoter(idNumber, phone);
  if (!voter) return end(error);
  return end(
    `REGISTERED VOTER\n${voter.fullName.split(" ")[0]}, ID ${voter.idNumber}\n${voter.ward} Ward, ${voter.county}\nStatus: ${voter.hasVoted ? "ALREADY VOTED" : "Not yet voted"}`
  );
}
