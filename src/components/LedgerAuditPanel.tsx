"use client";

import { useState } from "react";
import { Bug, CheckCircle2, Cpu, Loader2, RotateCcw, ShieldAlert, ShieldCheck, Skull } from "lucide-react";
import { useToast } from "@/components/Toast";
import { useI18n } from "@/lib/i18n/I18n";

export type LiveAudit = {
  ledgerIntact: boolean;
  chainIntact: boolean;
  blocksVerified: number;
  tamperedVotes: number;
  issues: { seq: number; receiptCode: string; problem: string }[];
  cacheDrift: { id: string; name: string; cached: number; ledger: number }[];
  chains: number;
  merkleRoot: string;
};

type FullAudit = {
  intact: boolean;
  checked: number;
  tamperedVotes: number;
  issues: { seq: number; receiptCode: string; problem: string }[];
  ms: number;
};

type Simulation = {
  target: {
    seq: number;
    receiptCode: string;
    seat: string;
    seatLabel: string;
    from: string;
    to: string;
    storedHash: string;
    recomputedHash: string;
  };
  attackFlipVote: { detected: boolean; issues: { seq: number; problem: string }[] };
  attackRehash: { detected: boolean; issues: { seq: number; problem: string }[]; note: string };
  attackRewriteChain: { detected: boolean; issues: { seq: number; problem: string }[]; note: string };
};

export function LedgerAuditPanel({ live }: { live: LiveAudit | null }) {
  const toast = useToast();
  const { t, serverText } = useI18n();
  const [full, setFull] = useState<FullAudit | null>(null);
  const [sim, setSim] = useState<Simulation | null>(null);
  const [busy, setBusy] = useState<"audit" | "sim" | null>(null);
  const problem = (p: string) => t(`audit.problems.${p}`);

  async function runAudit() {
    setBusy("audit");
    setSim(null);
    try {
      const res = await fetch("/api/ledger/audit", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(serverText(data.error) || t("audit.failed"));
      setFull(data.audit);
      if (data.audit.intact) toast.success(t("audit.toastOkTitle"), t("audit.toastOkBody", { n: data.audit.checked, ms: data.audit.ms }));
      else toast.error(t("audit.toastBadTitle"), t("audit.toastBadBody", { n: data.audit.tamperedVotes }));
    } catch (err) {
      toast.error(t("audit.failed"), (err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function runSimulation() {
    setBusy("sim");
    try {
      const res = await fetch("/api/ledger/audit?simulate=1", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(serverText(data.error) || t("audit.simFailed"));
      setSim(data.simulation);
      setFull(null);
      toast.error(t("audit.toastSimTitle"), t("audit.toastSimBody", { seq: data.simulation.target.seq }));
    } catch (err) {
      toast.info(t("audit.simUnavailable"), (err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // The badge follows the live 3-second audit; the button adds an explicit full recompute.
  const intact = live ? live.ledgerIntact : (full?.intact ?? true);
  const checked = live?.blocksVerified ?? full?.checked ?? 0;
  const tampered = live?.tamperedVotes ?? full?.tamperedVotes ?? 0;
  const issues = live?.issues ?? full?.issues ?? [];

  return (
    <section className="glass space-y-6 p-6 sm:p-9" aria-labelledby="audit-heading">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="eyebrow">{t("audit.eyebrow")}</p>
          <h2 id="audit-heading" className="mt-2 font-display text-4xl text-ink">
            {t("audit.title")}
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-soft">{t("audit.text")}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button onClick={runAudit} disabled={!!busy} className="btn-ink px-4 py-2.5 text-sm">
            {busy === "audit" ? <Loader2 className="size-4 animate-spin" /> : <Cpu className="size-4" />} {t("audit.verify")}
          </button>
          <button onClick={runSimulation} disabled={!!busy} className="btn-danger px-4 py-2.5 text-sm">
            {busy === "sim" ? <Loader2 className="size-4 animate-spin" /> : <Bug className="size-4" />} {t("audit.simulate")}
          </button>
        </div>
      </div>

      {/* Live integrity badge */}
      {!sim && (
        <div
          className={`flex flex-col gap-4 rounded-2xl p-6 sm:flex-row sm:items-center sm:justify-between ${intact ? "bg-forest text-white" : "animate-pulse bg-clay text-white"}`}
          role={intact ? "status" : "alert"}
        >
          <div className="flex items-center gap-4">
            {intact ? <ShieldCheck className="size-10 shrink-0" /> : <ShieldAlert className="size-10 shrink-0" />}
            <div>
              <p className="font-display text-3xl leading-tight">
                {intact
                  ? t("audit.intact")
                  : tampered > 0
                    ? t("audit.tamperedVotes", { n: tampered })
                    : t("audit.tamperedTally", { n: live?.cacheDrift.length ?? 0 })}
              </p>
              <p className="mt-1 font-mono text-xs text-white/75">
                {t("audit.rehashed", { n: checked })}
                {live?.merkleRoot && <> · {t("audit.chainsRoot", { n: live.chains, root: live.merkleRoot.slice(0, 16) })}</>}
              </p>
            </div>
          </div>
          {full && (
            <span className="flex items-center gap-1.5 font-mono text-xs text-white/85">
              {full.intact ? <CheckCircle2 className="size-3.5" /> : <ShieldAlert className="size-3.5" />}
              {t("audit.fullRecompute", { n: full.checked, ms: full.ms, t: full.tamperedVotes })}
            </span>
          )}
        </div>
      )}

      {!sim && !intact && (issues.length > 0 || (live?.cacheDrift.length ?? 0) > 0) && (
        <ul className="space-y-1.5 rounded-2xl border border-clay/40 bg-clay-soft p-4 font-mono text-xs text-clay">
          {issues.map((i, idx) => (
            <li key={idx}>{t("audit.issueBallot", { seq: i.seq, code: i.receiptCode, text: problem(i.problem) })}</li>
          ))}
          {live?.cacheDrift.map((d) => (
            <li key={d.id}>{t("audit.issueTally", { name: d.name, cached: d.cached, ledger: d.ledger })}</li>
          ))}
        </ul>
      )}

      {/* Simulation result */}
      {sim && (
        <div className="space-y-4 animate-fade-up">
          <div className="overflow-hidden rounded-2xl border border-clay bg-clay-soft" role="alert">
            <div className="flex items-center gap-2 bg-clay px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.16em] text-white">
              <Skull className="size-4" /> {t("audit.intrusion")}
            </div>
            <div className="space-y-4 p-5 text-sm text-clay">
              <p className="leading-relaxed">
                {t("audit.attackStory", {
                  seq: sim.target.seq,
                  code: sim.target.receiptCode,
                  seat: sim.target.seat ? t(`positions.${sim.target.seat}`) : sim.target.seatLabel,
                  from: sim.target.from,
                  to: sim.target.to,
                })}
              </p>
              <div className="grid gap-2 font-mono text-[11px] sm:grid-cols-2">
                <div className="rounded-xl bg-surface p-3">
                  <p className="text-ink-soft">{t("audit.storedSeal")}</p>
                  <p className="mt-1 break-all text-forest">{sim.target.storedHash}</p>
                </div>
                <div className="rounded-xl bg-surface p-3">
                  <p className="text-ink-soft">{t("audit.forgedHash")}</p>
                  <p className="mt-1 break-all text-clay">{sim.target.recomputedHash}</p>
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <AttackCard title={t("audit.attack1")} detected={sim.attackFlipVote.detected} issues={sim.attackFlipVote.issues} explain={t("audit.attack1Explain")} />
            <AttackCard title={t("audit.attack2")} detected={sim.attackRehash.detected} issues={sim.attackRehash.issues} explain={serverText(sim.attackRehash.note)} />
            <AttackCard title={t("audit.attack3")} detected={sim.attackRewriteChain.detected} issues={sim.attackRewriteChain.issues} explain={serverText(sim.attackRewriteChain.note)} />
          </div>

          <div className="flex flex-col gap-3 text-sm text-ink-soft sm:flex-row sm:items-center sm:justify-between">
            <p>{t("audit.notModified")}</p>
            <button onClick={() => setSim(null)} className="btn-ghost shrink-0 px-4 py-2 text-sm">
              <RotateCcw className="size-3.5" /> {t("audit.backToLive")}
            </button>
          </div>
        </div>
      )}
    </section>
  );

  function AttackCard(props: { title: string; detected: boolean; issues: { seq: number; problem: string }[]; explain: string }) {
    return (
      <div className="card space-y-3">
        <p className="font-semibold text-ink">{props.title}</p>
        <p
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            props.detected ? "bg-forest-soft text-forest" : "bg-clay-soft text-clay"
          }`}
        >
          {props.detected ? <ShieldCheck className="size-3.5" /> : <ShieldAlert className="size-3.5" />}
          {props.detected ? t("audit.detected") : t("audit.notDetected")}
        </p>
        <p className="text-sm leading-relaxed text-ink-soft">{props.explain}</p>
        <ul className="space-y-1 font-mono text-[11px] text-clay">
          {props.issues.map((i, idx) => (
            <li key={idx}>
              ✖ #{i.seq}: {problem(i.problem)}
            </li>
          ))}
        </ul>
      </div>
    );
  }
}
