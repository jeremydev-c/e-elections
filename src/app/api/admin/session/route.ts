import { NextResponse, type NextRequest } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { audit } from "@/lib/audit";
import { hashPassword, verifyPassword } from "@/lib/password";
import { clearFailures, clientIp, lockedFor, recordFailure } from "@/lib/rateLimit";
import { ADMIN_COOKIE, ADMIN_TTL, cookieOptions, getAdmin, signToken } from "@/lib/session";
import { Admin } from "@/models/Election";

// Verified against when the username does not exist, so a wrong username
// takes as long as a wrong password (no username discovery by timing).
let dummyHash: Promise<string> | undefined;

/** GET /api/admin/session: who is logged in? */
export async function GET(req: NextRequest) {
  const admin = await getAdmin(req);
  return NextResponse.json({ loggedIn: !!admin, username: admin?.username ?? null });
}

/**
 * POST /api/admin/session: log in.
 * 5 failures lock the IP for 5 minutes; 10 failures lock the USERNAME for
 * 15 minutes (stops slow attacks spread across many addresses).
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const username = String(body.username ?? "").trim().toLowerCase().slice(0, 64);
  const password = String(body.password ?? "").slice(0, 200);

  const ipKey = `admin-ip:${clientIp(req)}`;
  const userKey = `admin-user:${username}`;
  const wait = Math.max(lockedFor(ipKey), lockedFor(userKey));
  if (wait) {
    return NextResponse.json({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` }, { status: 429 });
  }

  await connectDB();
  const admin = await Admin.findOne({ username });
  const ok = admin
    ? await verifyPassword(password, admin.passwordHash)
    : (await verifyPassword(password, await (dummyHash ??= hashPassword("not-a-real-password"))), false);

  if (!ok) {
    recordFailure(ipKey, 5, 5 * 60_000);
    recordFailure(userKey, 10, 15 * 60_000);
    const lockedNow = lockedFor(ipKey) || lockedFor(userKey);
    await audit(lockedNow ? "ADMIN_LOCKED_OUT" : "ADMIN_LOGIN_FAILED", {
      req,
      severity: lockedNow ? "critical" : "warning",
      actor: username || "(blank)",
    });
    return NextResponse.json({ error: "Invalid username or password." }, { status: 401 });
  }

  clearFailures(ipKey);
  clearFailures(userKey);
  await audit("ADMIN_LOGIN", { req, actor: username });
  const token = await signToken({ role: "admin", username, sub: String(admin!._id) }, ADMIN_TTL);
  const res = NextResponse.json({ loggedIn: true, username });
  res.cookies.set(ADMIN_COOKIE, token, cookieOptions(ADMIN_TTL));
  return res;
}

/** DELETE /api/admin/session: log out. */
export async function DELETE() {
  const res = NextResponse.json({ loggedIn: false });
  res.cookies.set(ADMIN_COOKIE, "", cookieOptions(0));
  return res;
}
