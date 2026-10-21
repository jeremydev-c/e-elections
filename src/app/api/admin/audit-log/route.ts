import { NextResponse, type NextRequest } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { getAdmin } from "@/lib/session";
import { AuditLog } from "@/models/AuditLog";

/** GET /api/admin/audit-log: the 100 most recent security events (officials only). */
export async function GET(req: NextRequest) {
  if (!(await getAdmin(req))) {
    return NextResponse.json({ error: "Election official login required." }, { status: 401 });
  }
  await connectDB();
  const events = await AuditLog.find().sort({ at: -1 }).limit(100).lean();
  return NextResponse.json({
    events: events.map((e) => ({
      id: String(e._id),
      at: e.at,
      event: e.event,
      severity: e.severity,
      actor: e.actor ?? null,
      idNumber: e.idNumber ?? null,
      ip: e.ip ?? null,
      detail: e.detail ?? null,
    })),
  });
}
