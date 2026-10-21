"use client";

import { useState } from "react";
import { Bug, CheckCircle2, Cpu, Loader2, RotateCcw, ShieldAlert, ShieldCheck, Skull } from "lucide-react";
import { useToast } from "@/components/Toast";

export type LiveAudit = {
  ledgerIntact: boolean;
  chainIntact: boolean;
  blocksVerified: number;
  tamperedVotes: number;
  issues: { seq: number; receiptCode: string; problem: string }[];
  cacheDrift: { id: string; name: string; cached: number; ledger: number }[];
  latestHash: string | null;
  headSeq: number;
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

const PROBLEM_TEXT: Record<string, string> = {
  HASH_MISMATCH: "contents changed: SHA-256 seal no longer matches",
  BROKEN_LINK: "chain link broken: previousHash points to a different ballot",
  SEQUENCE_GAP: "ballot missing from the sequence (deleted?)",
  HEAD_MISMATCH: "chain head disagrees: newest ballot deleted or altered",
  BAD_SEAL: "HMAC server seal invalid: record forged without the secret ledger key",
  BAD_HEAD_SEAL: "chain head seal invalid: head rewritten or rolled back",
  TURNOUT_MISMATCH: "ballot count differs from voters marked as voted (ballot deleted or stuffed)",
};

export function LedgerAuditPanel({ live }: { live: LiveAudit | null }) {
  const toast = useToast();
  const [full, setFull] = useState<FullAudit | null>(null);
  const [sim, setSim] = useState<Simulation | null>(null);
  const [busy, setBusy] = useState<"audit" | "sim" | null>(null);

  async function runAudit() {
    setBusy("audit");
    setSim(null);
    try {
      const res = await fetch("/api/ledger/audit", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Audit failed");
      setFull(data.audit);
      if (data.audit.intact) toast.success("Chain verified", `${data.audit.checked} ballots re-hashed in ${data.audit.ms} ms`);
      else toast.error("Tampering detected", `${data.audit.tamperedVotes} ballot(s) failed verification`);
    } catch (err) {
      toast.error("Audit failed", (err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function runSimulation() {
    setBusy("sim");
    try {
      const res = await fetch("/api/ledger/audit?simulate=1", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Simulation failed");
      setSim(data.simulation);
      setFull(null);
      toast.error("ALERT: Hacker tamper detected", `Forged ballot #${data.simulation.target.seq} caught by SHA-256 audit`);
    } catch (err) {
      toast.info("Tamper test unavailable", (err as Error).message);
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
    <section className="glass space-y-5 p-6 sm:p-8" aria-labelledby="audit-heading">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-forest">Anti-Hacking Ledger Audit</p>
          <h2 id="audit-heading" className="font-display mt-1 text-xl font-bold text-ink">
            SHA-256 Chain Integrity
          </h2>
          <p className="mt-1 max-w-xl text-xs text-ink-soft">
            Every ballot stores the hash of the ballot before it and carries an HMAC seal made with a secret server key
            that never touches the database. Changing, deleting, reordering or re-hashing any vote breaks the chain,
            and this audit re-checks all of it from scratch.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button onClick={runAudit} disabled={!!busy} className="btn-primary px-4 py-2.5 text-sm">
            {busy === "audit" ? <Loader2 className="size-4 animate-spin" /> : <Cpu className="size-4" />} Verify SHA-256
            Chain Integrity
          </button>
          <button onClick={runSimulation} disabled={!!busy} className="btn-danger px-4 py-2.5 text-sm">
            {busy === "sim" ? <Loader2 className="size-4 animate-spin" /> : <Bug className="size-4" />} Simulate Hacker
            Tamper Test
          </button>
        </div>
      </div>

      {/* Live integrity badge */}
      {!sim && (
        <div
          className={`flex flex-col gap-3 rounded-2xl border-2 p-5 sm:flex-row sm:items-center sm:justify-between ${
            intact ? "border-forest/30 bg-forest-soft" : "border-clay bg-clay-soft animate-pulse"
          }`}
          role={intact ? "status" : "alert"}
        >
          <div className="flex items-center gap-4">
            <span
              className={`grid size-14 place-items-center rounded-2xl ${intact ? "bg-forest text-white" : "bg-clay text-white"}`}
            >
              {intact ? <ShieldCheck className="size-8" /> : <ShieldAlert className="size-8" />}
            </span>
            <div>
              <p className={`text-xl font-black tracking-tight ${intact ? "text-forest" : "text-clay"}`}>
                {intact
                  ? "100% INTACT - 0 TAMPERED VOTES"
                  : tampered > 0
                    ? `TAMPERING DETECTED - ${tampered} TAMPERED VOTE${tampered === 1 ? "" : "S"}`
                    : `TAMPERING DETECTED - ${live?.cacheDrift.length ?? 0} ALTERED TALLY RECORD${live?.cacheDrift.length === 1 ? "" : "S"}`}
              </p>
              <p className="text-xs text-ink-soft">
                {checked} ballot{checked === 1 ? "" : "s"} re-hashed · live, every 3 s
                {live?.latestHash && <span className="font-mono text-ink-faint"> · head {live.latestHash.slice(0, 16)}…</span>}
              </p>
            </div>
          </div>
          {full && (
            <span className={`flex items-center gap-1 text-xs ${full.intact ? "text-forest" : "text-clay"}`}>
              {full.intact ? <CheckCircle2 className="size-3.5" /> : <ShieldAlert className="size-3.5" />}
              Full recompute: {full.checked} ballots in {full.ms} ms, {full.tamperedVotes} tampered
            </span>
          )}
        </div>
      )}

      {!sim && !intact && (issues.length > 0 || (live?.cacheDrift.length ?? 0) > 0) && (
        <ul className="space-y-1.5 rounded-2xl border border-clay/40 bg-clay-soft p-4 font-mono text-xs text-clay">
          {issues.map((i, idx) => (
            <li key={idx}>
              ✖ Ballot #{i.seq} ({i.receiptCode}): {PROBLEM_TEXT[i.problem] ?? i.problem}
            </li>
          ))}
          {live?.cacheDrift.map((d) => (
            <li key={d.id}>
              ✖ Tally cache for {d.name} says {d.cached} but the verified ledger says {d.ledger} (results use the ledger)
            </li>
          ))}
        </ul>
      )}

      {/* Simulation result */}
      {sim && (
        <div className="space-y-4 animate-fade-up">
          <div className="overflow-hidden rounded-2xl border-2 border-clay bg-clay-soft shadow-sm " role="alert">
            <div className="flex items-center gap-2 bg-clay px-5 py-2 text-xs font-black uppercase tracking-widest text-white">
              <Skull className="size-4" /> Intrusion alert · simulated attack on a copy of the live ledger
            </div>
            <div className="space-y-3 p-5 text-sm text-clay">
              <p>
                A &quot;hacker&quot; with database access changed ballot <strong>#{sim.target.seq}</strong> (
                <span className="font-mono">{sim.target.receiptCode}</span>): <strong>{sim.target.seatLabel}</strong>{" "}
                vote moved from <strong>{sim.target.from}</strong> to <strong>{sim.target.to}</strong>.
              </p>
              <div className="grid gap-2 font-mono text-[11px] sm:grid-cols-2">
                <div className="rounded-xl bg-paper p-3">
                  <p className="text-ink-soft">Stored seal (original)</p>
                  <p className="break-all text-forest">{sim.target.storedHash}</p>
                </div>
                <div className="rounded-xl bg-paper p-3">
                  <p className="text-ink-soft">SHA-256 of the forged ballot</p>
                  <p className="break-all text-clay">{sim.target.recomputedHash}</p>
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <AttackCard
              n={1}
              title="Attack 1: change the vote only"
              detected={sim.attackFlipVote.detected}
              issues={sim.attackFlipVote.issues}
              explain="The stored seal no longer matches the recomputed SHA-256 of the ballot."
            />
            <AttackCard
              n={2}
              title="Attack 2: change the vote AND re-seal it"
              detected={sim.attackRehash.detected}
              issues={sim.attackRehash.issues}
              explain={sim.attackRehash.note}
            />
            <AttackCard
              n={3}
              title="Attack 3: rewrite the entire chain"
              detected={sim.attackRewriteChain.detected}
              issues={sim.attackRewriteChain.issues}
              explain={sim.attackRewriteChain.note}
            />
          </div>

          <div className="flex flex-col gap-2 text-xs text-ink-soft sm:flex-row sm:items-center sm:justify-between">
            <p>
              The real database was not modified. For a live demo, edit any <span className="font-mono">vote_ledger</span>{" "}
              document in MongoDB Atlas: the badge above turns red within 3 seconds.
            </p>
            <button onClick={() => setSim(null)} className="btn-ghost shrink-0 px-3 py-2 text-xs">
              <RotateCcw className="size-3.5" /> Back to live audit
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function AttackCard(props: {
  n: number;
  title: string;
  detected: boolean;
  issues: { seq: number; problem: string }[];
  explain: string;
}) {
  return (
    <div className="card space-y-2">
      <p className="text-sm font-bold text-ink">{props.title}</p>
      <p
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-bold ${
          props.detected ? "bg-forest-soft text-forest" : "bg-clay-soft text-clay"
        }`}
      >
        {props.detected ? <ShieldCheck className="size-3.5" /> : <ShieldAlert className="size-3.5" />}
        {props.detected ? "DETECTED by the audit" : "Not detected"}
      </p>
      <p className="text-xs text-ink-soft">{props.explain}</p>
      <ul className="space-y-1 font-mono text-[11px] text-clay">
        {props.issues.map((i, idx) => (
          <li key={idx}>
            ✖ #{i.seq}: {PROBLEM_TEXT[i.problem] ?? i.problem}
          </li>
        ))}
      </ul>
    </div>
  );
}
