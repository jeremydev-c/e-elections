"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  Database,
  KeyRound,
  Loader2,
  RotateCcw,
  Sprout,
  TriangleAlert,
  UserCog,
  UserPlus,
} from "lucide-react";
import { PageTitle } from "@/components/Brand";
import { useToast } from "@/components/Toast";
import { AuditLogPanel } from "@/components/AuditLogPanel";

type Status = {
  ok: boolean;
  error?: string;
  hasAdmin: boolean;
  admin: string | null;
  counts: { candidates: number; voters: number; ballots: number };
  election: { name: string; status: string; closesAt: string } | null;
};

type SeedResponse = {
  ok?: boolean;
  error?: string;
  log?: string[];
  admin?: { username: string; password: string };
};

export default function SetupPage() {
  const toast = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [newAdmin, setNewAdmin] = useState<SeedResponse["admin"]>();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/seed", { cache: "no-store" });
      setStatus(await res.json());
    } catch (err) {
      setStatus({ ok: false, error: (err as Error).message } as Status);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  async function seed(reset: "none" | "votes" | "all") {
    if (reset === "votes" && !confirm("Wipe ALL ballots and let every voter vote again?")) return;
    if (reset === "all" && prompt('This deletes every voter and ballot. Type "RESET" to confirm.') !== "RESET") return;

    setBusy(reset);
    setLog(["Working… (inserting ~4,200 candidates can take up to a minute on a cold cluster)"]);
    try {
      const res = await fetch("/api/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reset }),
      });
      const data: SeedResponse = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) throw new Error(data.error ?? "Seed failed");
      setLog(data.log ?? []);
      if (data.admin) setNewAdmin(data.admin);
      toast.success(reset === "none" ? "Demo data ready" : "Reset complete", "Database seeded for judging.");
      await load();
    } catch (err) {
      setLog([`✖ ${(err as Error).message}`]);
      toast.error("Seed failed", (err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy("login");
    try {
      const res = await fetch("/api/admin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Login failed");
      setPassword("");
      toast.success("Signed in", `Welcome, ${data.username}`);
      await load();
    } catch (err) {
      toast.error("Login failed", (err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const canManage = !!status?.admin;

  return (
    <main className="mx-auto min-h-dvh max-w-4xl space-y-6 px-4 py-8">
      <PageTitle eyebrow="Officials' portal" title="Setup & Seed Data">
        {canManage && (
          <Link href="/register" id="go-register" className="btn-primary px-4 py-2 text-sm">
            <UserPlus className="size-4" aria-hidden /> Register voters
          </Link>
        )}
      </PageTitle>

      {/* Status */}
      <section className="glass space-y-4 p-6">
        <div className="flex items-center gap-2">
          <Database className="size-5 text-forest" />
          <h2 className="font-display font-bold text-ink">MongoDB Atlas status</h2>
        </div>
        {!status ? (
          <p className="flex items-center gap-2 text-sm text-ink-soft">
            <Loader2 className="size-4 animate-spin" /> Connecting…
          </p>
        ) : !status.ok ? (
          <p className="flex items-start gap-2 rounded-xl border border-clay/40 bg-clay-soft p-3 text-sm text-clay">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" /> Cannot reach the database: {status.error}. Check
            MONGODB_URI in .env.local and that your IP is allowed in Atlas → Network Access.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Candidates" value={status.counts.candidates} />
            <Stat label="Registered voters" value={status.counts.voters} />
            <Stat label="Ballots in ledger" value={status.counts.ballots} />
            <Stat label="Election" value={status.election?.status ?? "NOT SET"} />
          </div>
        )}
      </section>

      {/* First-run admin password */}
      {newAdmin && (
        <section className="space-y-2 rounded-2xl border-2 border-ochre/40 bg-ochre-soft p-5" role="alert">
          <p className="flex items-center gap-2 font-bold text-ochre-deep">
            <KeyRound className="size-5" /> Election official account created: save this password now
          </p>
          <p className="font-mono text-sm text-ink">
            username: <strong>{newAdmin.username}</strong> · password: <strong>{newAdmin.password}</strong>
          </p>
          <p className="text-xs text-ochre-deep">It is stored only as a scrypt hash and will never be shown again.</p>
        </section>
      )}

      {/* Actions */}
      {status?.ok && (
        <section className="glass space-y-5 p-6">
          <div className="flex items-center gap-2">
            <Sprout className="size-5 text-forest" />
            <h2 className="font-display font-bold text-ink">Seed demo data</h2>
          </div>
          <p className="text-sm text-ink-soft">
            Creates fictional candidates for all 6 seats in all 47 counties, 290 constituencies and 1,450 wards, opens
            the election window. Safe to run again: existing data is kept.
          </p>

          {!status.hasAdmin || canManage ? (
            <div className="flex flex-wrap gap-3">
              <button onClick={() => seed("none")} disabled={!!busy} className="btn-primary">
                {busy === "none" ? <Loader2 className="size-4 animate-spin" /> : <Sprout className="size-4" />}
                {status.hasAdmin ? "Seed / top up demo data" : "Initialize demo database"}
              </button>
              {canManage && (
                <>
                  <button onClick={() => seed("votes")} disabled={!!busy} className="btn-ghost">
                    {busy === "votes" ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
                    Reset votes (keep voters)
                  </button>
                  <button onClick={() => seed("all")} disabled={!!busy} className="btn-danger">
                    {busy === "all" ? <Loader2 className="size-4 animate-spin" /> : <TriangleAlert className="size-4" />}
                    Full reset
                  </button>
                </>
              )}
            </div>
          ) : (
            <form onSubmit={login} className="grid gap-3 rounded-2xl border border-line bg-paper p-4 sm:grid-cols-[1fr_1fr_auto]">
              <p className="flex items-center gap-2 text-sm text-ink-soft sm:col-span-3">
                <UserCog className="size-4 text-forest" /> Sign in as an election official to seed or reset.
              </p>
              <input className="field" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" autoComplete="username" />
              <input
                className="field"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                autoComplete="current-password"
              />
              <button className="btn-primary" disabled={busy === "login" || !password}>
                {busy === "login" && <Loader2 className="size-4 animate-spin" />} Sign in
              </button>
            </form>
          )}

          {log.length > 0 && (
            <ul className="space-y-1 rounded-xl bg-paper p-4 font-mono text-xs text-forest">
              {log.map((l, i) => (
                <li key={i}>{l.startsWith("✖") ? l : `✔ ${l}`}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {canManage && <AuditLogPanel />}

      {/* Judge walkthrough */}
      <section className="glass space-y-3 p-6">
        <h2 className="font-display font-bold text-ink">5-minute judging walkthrough</h2>
        <ol className="space-y-2 text-sm text-ink-soft">
          {[
            ["/register", "Register a judge with a live face scan and a fingerprint"],
            ["/login", "Vote: ID check → choose Face or Fingerprint → location-aware ballot"],
            ["/results", "Watch the bars jump within 3 s; verify the receipt; run the chain audit"],
            ["/results", "Press \"Simulate Hacker Tamper Test\" to show the SHA-256 alarm"],
            ["/login", "Try the same ID again: ACCESS DENIED (double voting blocked)"],
          ].map(([href, text], i) => (
            <li key={i} className="flex items-start gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-forest-soft text-xs font-bold text-forest">
                {i + 1}
              </span>
              <Link href={href} className="hover:text-ink">
                {text}
              </Link>
            </li>
          ))}
        </ol>
        <p className="flex items-center gap-1.5 pt-1 text-xs text-ink-faint">
          <CheckCircle2 className="size-3.5" /> Command-line alternative: <span className="font-mono">npm run seed</span>
        </p>
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="card p-4">
      <p className="text-[11px] uppercase tracking-wide text-ink-soft">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums text-ink">{typeof value === "number" ? value.toLocaleString() : value}</p>
    </div>
  );
}
