"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, ScrollText } from "lucide-react";

type Event = {
  id: string;
  at: string;
  event: string;
  severity: "info" | "warning" | "critical";
  actor: string | null;
  idNumber: string | null;
  ip: string | null;
  detail: string | null;
};

const TONE: Record<Event["severity"], string> = {
  info: "bg-paper-2 text-ink-soft",
  warning: "bg-ochre-soft text-ochre-deep",
  critical: "bg-clay-soft text-clay",
};

/** Officials' view of the security event log (failures and admin actions only). */
export function AuditLogPanel() {
  const [events, setEvents] = useState<Event[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/audit-log", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load the log");
      setEvents(data.events);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <section className="glass space-y-4 p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-display text-xl font-semibold text-ink">
            <ScrollText className="size-5 text-forest" /> Security audit log
          </h2>
          <p className="mt-1 max-w-xl text-xs text-ink-soft">
            Failed logins, blocked double votes, failed face or fingerprint checks, rejected ballots, tamper alarms and
            admin actions. Successful votes are never logged against an ID, to protect the secret ballot.
          </p>
        </div>
        <button onClick={load} className="btn-ghost shrink-0 p-2" title="Refresh" disabled={loading}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        </button>
      </div>

      {error && <p className="text-sm text-clay">{error}</p>}
      {events && events.length === 0 && <p className="text-sm text-ink-faint">No security events yet.</p>}
      {events && events.length > 0 && (
        <div className="max-h-96 overflow-auto rounded-xl border border-line">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="sticky top-0 bg-paper-2 text-ink-soft">
              <tr>
                <th className="px-3 py-2 font-semibold">Time</th>
                <th className="px-3 py-2 font-semibold">Event</th>
                <th className="px-3 py-2 font-semibold">Who</th>
                <th className="px-3 py-2 font-semibold">Detail</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-t border-line align-top">
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-ink-faint">
                    {new Date(e.at).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "medium" })}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 font-semibold ${TONE[e.severity]}`}>
                      {e.event.replaceAll("_", " ").toLowerCase()}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-ink-soft">
                    {e.actor ?? (e.idNumber ? `ID ${e.idNumber}` : "—")}
                    {e.ip && <span className="block font-mono text-[10px] text-ink-faint">{e.ip}</span>}
                  </td>
                  <td className="px-3 py-2 text-ink-soft">{e.detail ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
