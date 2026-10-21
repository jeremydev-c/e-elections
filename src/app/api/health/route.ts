import { NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";

/** GET /api/health — confirms the app can reach MongoDB Atlas. */
export async function GET() {
  const started = Date.now();
  try {
    const conn = await connectDB();
    await conn.connection.db!.admin().ping();
    return NextResponse.json({
      ok: true,
      database: conn.connection.name,
      latencyMs: Date.now() - started,
    });
  } catch (err) {
    console.error("Health check failed:", err);
    return NextResponse.json({ ok: false, error: "Database unreachable." }, { status: 503 });
  }
}
