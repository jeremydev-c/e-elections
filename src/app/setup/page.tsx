"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, CheckCircle2, Database, KeyRound, Loader2, RotateCcw, Sprout, TriangleAlert, UserCog, UserPlus } from "lucide-react";
import { PageTitle } from "@/components/Brand";
import { useToast } from "@/components/Toast";
import { AuditLogPanel } from "@/components/AuditLogPanel";
import { useI18n } from "@/lib/i18n/I18n";

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

const WALK_LINKS = ["/register", "/login", "/results", "/results", "/login"];

export default function SetupPage() {
  const toast = useToast();
  const { t, list, serverText, locale } = useI18n();
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
    const id = setTimeout(load, 0);
    return () => clearTimeout(id);
  }, [load]);

  async function seed(reset: "none" | "votes" | "all") {
    if (reset === "votes" && !confirm(t("setup.confirmVotes"))) return;
    if (reset === "all" && prompt(t("setup.confirmAll")) !== "RESET") return;

    setBusy(reset);
    setLog([t("setup.working")]);
    try {
      const res = await fetch("/api/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reset }),
      });
      const data: SeedResponse = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) throw new Error(serverText(data.error) || t("setup.seedFailed"));
      setLog(data.log ?? []);
      if (data.admin) setNewAdmin(data.admin);
      toast.success(reset === "none" ? t("setup.seeded") : t("setup.resetDone"), t("setup.seededBody"));
      await load();
    } catch (err) {
      setLog([`✖ ${(err as Error).message}`]);
      toast.error(t("setup.seedFailed"), (err as Error).message);
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
      if (!res.ok) throw new Error(serverText(data.error) || t("setup.loginFailed"));
      setPassword("");
      toast.success(t("setup.signedIn"), t("setup.welcome", { name: data.username }));
      await load();
    } catch (err) {
      toast.error(t("setup.loginFailed"), (err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const canManage = !!status?.admin;
  const electionStatus = status?.election?.status;

  return (
    <main className="mx-auto min-h-dvh max-w-4xl space-y-6 px-4 py-12">
      <PageTitle eyebrow={t("setup.eyebrow")} title={t("setup.title")}>
        {canManage && (
          <Link href="/register" id="go-register" className="btn-primary px-5 py-2.5 text-sm">
            <UserPlus className="size-4" aria-hidden /> {t("setup.register")}
          </Link>
        )}
      </PageTitle>

      {/* Status */}
      <section className="glass space-y-5 p-6 sm:p-8">
        <h2 className="flex items-center gap-2.5 font-display text-3xl text-ink">
          <Database className="size-5 text-forest" /> {t("setup.dbTitle")}
        </h2>
        {!status ? (
          <p className="flex items-center gap-2 text-sm text-ink-soft">
            <Loader2 className="size-4 animate-spin" /> {t("setup.connecting")}
          </p>
        ) : !status.ok ? (
          <p className="flex items-start gap-2 rounded-xl border border-clay/40 bg-clay-soft p-3.5 text-sm text-clay">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {t("setup.dbError", { error: status.error ?? "" })}
          </p>
        ) : (
          <dl className="grid grid-cols-2 overflow-hidden rounded-xl border border-line sm:grid-cols-4">
            <Stat label={t("setup.candidates")} value={status.counts.candidates.toLocaleString(locale)} />
            <Stat label={t("setup.voters")} value={status.counts.voters.toLocaleString(locale)} />
            <Stat label={t("setup.ballots")} value={status.counts.ballots.toLocaleString(locale)} />
            <Stat label={t("setup.election")} value={electionStatus ? t(`results.statusValues.${electionStatus}`) : t("setup.notSet")} />
          </dl>
        )}
      </section>

      {/* First-run admin password */}
      {newAdmin && (
        <section className="space-y-2 rounded-2xl border border-ochre/50 bg-ochre-soft p-6" role="alert">
          <p className="flex items-center gap-2 font-semibold text-ochre-deep">
            <KeyRound className="size-5" /> {t("setup.newAdmin")}
          </p>
          <p className="font-mono text-sm text-ink">
            {t("common.username")}: <strong>{newAdmin.username}</strong> · {t("common.password")}: <strong>{newAdmin.password}</strong>
          </p>
          <p className="text-xs text-ochre-deep">{t("setup.newAdminNote")}</p>
        </section>
      )}

      {/* Actions */}
      {status?.ok && (
        <section className="glass space-y-5 p-6 sm:p-8">
          <h2 className="flex items-center gap-2.5 font-display text-3xl text-ink">
            <Sprout className="size-5 text-forest" /> {t("setup.seedTitle")}
          </h2>
          <p className="text-[15px] leading-relaxed text-ink-soft">{t("setup.seedText")}</p>

          {!status.hasAdmin || canManage ? (
            <div className="flex flex-wrap gap-3">
              <button onClick={() => seed("none")} disabled={!!busy} className="btn-primary">
                {busy === "none" ? <Loader2 className="size-4 animate-spin" /> : <Sprout className="size-4" />}
                {status.hasAdmin ? t("setup.seedTop") : t("setup.seedInit")}
              </button>
              {canManage && (
                <>
                  <button onClick={() => seed("votes")} disabled={!!busy} className="btn-ghost">
                    {busy === "votes" ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
                    {t("setup.resetVotes")}
                  </button>
                  <button onClick={() => seed("all")} disabled={!!busy} className="btn-danger">
                    {busy === "all" ? <Loader2 className="size-4 animate-spin" /> : <TriangleAlert className="size-4" />}
                    {t("setup.resetAll")}
                  </button>
                </>
              )}
            </div>
          ) : (
            <form onSubmit={login} className="grid gap-3 rounded-xl border border-line p-5 sm:grid-cols-[1fr_1fr_auto]">
              <p className="flex items-center gap-2 text-sm text-ink-soft sm:col-span-3">
                <UserCog className="size-4 text-forest" /> {t("setup.signInPrompt")}
              </p>
              <input
                className="field"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={t("common.username")}
                aria-label={t("common.username")}
                autoComplete="username"
              />
              <input
                className="field"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("common.password")}
                aria-label={t("common.password")}
                autoComplete="current-password"
              />
              <button className="btn-primary" disabled={busy === "login" || !password}>
                {busy === "login" && <Loader2 className="size-4 animate-spin" />} {t("common.signIn")}
              </button>
            </form>
          )}

          {log.length > 0 && (
            <ul className="space-y-1 rounded-xl bg-paper-2 p-4 font-mono text-xs text-forest">
              {log.map((l, i) => (
                <li key={i}>{l.startsWith("✖") ? l : `✔ ${l}`}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {canManage && <AuditLogPanel />}

      {/* Judge walkthrough */}
      <section className="glass space-y-4 p-6 sm:p-8">
        <h2 className="font-display text-3xl text-ink">{t("setup.walkTitle")}</h2>
        <ol className="divide-y divide-line">
          {list<string>("setup.walk").map((text, i) => (
            <li key={i}>
              <Link href={WALK_LINKS[i]} className="group flex items-center gap-4 py-3.5 text-[15px] text-ink-soft hover:text-ink">
                <span className="font-display text-2xl leading-none text-line-strong group-hover:text-forest">{String(i + 1).padStart(2, "0")}</span>
                <span className="flex-1">{text}</span>
                <ArrowUpRight className="size-4 shrink-0 text-ink-faint" aria-hidden />
              </Link>
            </li>
          ))}
        </ol>
        <p className="flex items-center gap-1.5 text-sm text-ink-faint">
          <CheckCircle2 className="size-3.5" /> {t("setup.cli")} <span className="font-mono">npm run seed</span>
        </p>
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-line bg-surface p-4 [&:not(:last-child)]:border-r max-sm:[&:nth-child(2)]:border-r-0 max-sm:[&:nth-child(-n+2)]:border-b">
      <dt className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-faint">{label}</dt>
      <dd className="mt-2 font-display text-3xl leading-none tabular-nums text-ink">{value}</dd>
    </div>
  );
}
