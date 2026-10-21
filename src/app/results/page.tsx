"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2, Pause, Play, RefreshCw, SearchCheck, ShieldAlert, ShieldCheck } from "lucide-react";
import { PageTitle } from "@/components/Brand";
import { LedgerAuditPanel, type LiveAudit } from "@/components/LedgerAuditPanel";
import { ReceiptVerifier } from "@/components/ReceiptVerifier";
import { useToast } from "@/components/Toast";
import { POSITIONS, POSITION_LABELS, type Position } from "@/lib/positions";
import { COUNTIES } from "@/lib/regions";

const REFRESH_MS = 3000;

type CandidateTally = {
  id: string;
  name: string;
  party: string;
  partyColor: string;
  votes: number;
  percent: number;
};

type ResultsOverview = {
  serverTime: string;
  election: { name: string; status: string; totalRegistered: number; totalVotesCast: number; turnoutPercent: number };
  audit: LiveAudit;
  presidential: { title: string; totalVotes: number; candidates: CandidateTally[] };
  ballotsByCounty: { county: string; ballots: number }[];
};

type RegionalResult = {
  position: Position;
  regionTitle: string;
  totalVotes: number;
  candidates: CandidateTally[];
};

export default function ResultsPage() {
  return (
    <Suspense fallback={<PageSpinner />}>
      <ResultsDashboard />
    </Suspense>
  );
}

function ResultsDashboard() {
  const receiptParam = useSearchParams().get("receipt") ?? "";
  const toast = useToast();

  const [data, setData] = useState<ResultsOverview | null>(null);
  const [loadError, setLoadError] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [position, setPosition] = useState<Position>("PRESIDENT");
  const [countyCode, setCountyCode] = useState("31"); // Laikipia
  const [constituencyCode, setConstituencyCode] = useState("163");
  const [wardCode, setWardCode] = useState("812");
  const [regional, setRegional] = useState<RegionalResult | null>(null);

  const [flash, setFlash] = useState<Set<string>>(new Set());
  const prevVotes = useRef(new Map<string, number>());
  const prevIntact = useRef(true);
  const inFlight = useRef(false);

  const regionCode = position === "MP" ? constituencyCode : position === "MCA" ? wardCode : countyCode;

  /** Highlights candidates whose count went up since the previous poll. */
  const markChanges = useCallback((rows: CandidateTally[]) => {
    const up = new Set<string>();
    for (const c of rows) {
      const before = prevVotes.current.get(c.id);
      if (before !== undefined && c.votes > before) up.add(c.id);
      prevVotes.current.set(c.id, c.votes);
    }
    if (up.size) {
      setFlash(up);
      setTimeout(() => setFlash(new Set()), 1600);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (inFlight.current) return; // never stack requests on a slow network
    inFlight.current = true;
    try {
      const overviewReq = fetch("/api/results", { cache: "no-store" });
      const regionalReq =
        position === "PRESIDENT"
          ? null
          : fetch(`/api/results/region?position=${position}&regionCode=${regionCode}`, { cache: "no-store" });

      const res = await overviewReq;
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setData(d);
      setLoadError("");
      setLastUpdated(Date.now());

      if (prevIntact.current && !d.audit.ledgerIntact) {
        toast.error("LEDGER TAMPERING DETECTED", "A ballot failed SHA-256 verification. See the audit panel.");
      }
      prevIntact.current = d.audit.ledgerIntact;

      if (regionalReq) {
        const r = await regionalReq;
        const rd = await r.json();
        if (r.ok) {
          setRegional(rd);
          markChanges(rd.candidates);
        }
      } else {
        markChanges(d.presidential.candidates);
      }
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, [position, regionCode, markChanges, toast]);

  // Initial load + whenever the race / region changes.
  useEffect(() => {
    const t = setTimeout(refresh, 0);
    return () => clearTimeout(t);
  }, [refresh]);

  // Live auto-refresh every 3 seconds.
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [autoRefresh, refresh]);

  // "Updated Xs ago" ticker.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const county = COUNTIES.find((c) => c.code === countyCode);
  const constituency = county?.constituencies.find((c) => c.code === constituencyCode);
  const rows = position === "PRESIDENT" ? data?.presidential.candidates : regional?.candidates;
  const total = position === "PRESIDENT" ? data?.presidential.totalVotes : regional?.totalVotes;
  const secondsAgo = lastUpdated ? Math.max(0, Math.round((now - lastUpdated) / 1000)) : null;

  return (
    <main className="mx-auto min-h-dvh max-w-6xl space-y-6 px-4 py-8">
      <PageTitle eyebrow="Official Real-Time Tally & Cryptographic Audit" title="Live Election Results">
        <div className="flex items-center gap-2 text-xs">
          <span className="flex items-center gap-2 rounded-full border border-line bg-paper px-3 py-1.5 text-ink-soft">
            <span className={`size-2 rounded-full ${autoRefresh ? "animate-pulse bg-forest" : "bg-ink-faint"}`} />
            {autoRefresh ? "LIVE" : "PAUSED"}
            {secondsAgo !== null && <span className="text-ink-faint">· {secondsAgo}s ago</span>}
          </span>
          <button
            onClick={() => setAutoRefresh((v) => !v)}
            className="btn-ghost p-2"
            title={autoRefresh ? "Pause auto-refresh" : "Resume auto-refresh"}
          >
            {autoRefresh ? <Pause className="size-4" /> : <Play className="size-4" />}
          </button>
          <button
            onClick={() => {
              setRefreshing(true);
              refresh();
            }}
            className="btn-ghost p-2"
            title="Refresh now"
          >
            <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
          </button>
        </div>
      </PageTitle>

      {loadError && (
        <p role="alert" className="rounded-xl border border-ochre/40 bg-ochre-soft p-3 text-sm text-ochre-deep">
          Could not reach the results server ({loadError}). Retrying every 3 seconds…{" "}
          <Link href="/setup" className="underline">
            Check setup
          </Link>
        </p>
      )}

      {/* KPI row */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Election status" value={data?.election.status ?? "…"} sub={data?.election.name ?? "General Election 2027"} />
        <Kpi
          label="National turnout"
          value={`${data?.election.turnoutPercent ?? 0}%`}
          sub={<Bar percent={data?.election.turnoutPercent ?? 0} color="#1f5a39" />}
        />
        <Kpi
          label="Ballots cast"
          value={(data?.election.totalVotesCast ?? 0).toLocaleString()}
          sub={`of ${(data?.election.totalRegistered ?? 0).toLocaleString()} registered`}
        />
        <Kpi
          label="Ledger integrity"
          tone={data && !data.audit.ledgerIntact ? "bad" : "good"}
          value={!data ? "…" : data.audit.ledgerIntact ? "100% intact" : "TAMPERED"}
          sub={`${data?.audit.blocksVerified ?? 0} ballots SHA-256 verified`}
          icon={data && !data.audit.ledgerIntact ? <ShieldAlert className="size-4" /> : <ShieldCheck className="size-4" />}
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        {/* Race results */}
        <section className="glass space-y-5 p-5 sm:p-7">
          <div className="flex flex-wrap gap-2">
            {POSITIONS.map((pos) => (
              <button
                key={pos}
                onClick={() => setPosition(pos)}
                className={`shrink-0 rounded-xl px-3.5 py-2 text-xs font-semibold transition ${
                  position === pos ? "bg-forest font-bold text-white" : "bg-paper text-ink-soft hover:text-ink"
                }`}
              >
                {POSITION_LABELS[pos]}
              </button>
            ))}
          </div>

          {position !== "PRESIDENT" && (
            <div className="grid gap-3 rounded-2xl border border-line bg-paper p-4 sm:grid-cols-3">
              <Select
                label="County"
                value={countyCode}
                onChange={(v) => {
                  const c = COUNTIES.find((x) => x.code === v);
                  setCountyCode(v);
                  setConstituencyCode(c?.constituencies[0]?.code ?? "");
                  setWardCode(c?.constituencies[0]?.wards[0]?.code ?? "");
                }}
                options={COUNTIES.map((c) => ({ value: c.code, label: c.name }))}
              />
              {(position === "MP" || position === "MCA") && (
                <Select
                  label="Constituency"
                  value={constituencyCode}
                  onChange={(v) => {
                    setConstituencyCode(v);
                    setWardCode(county?.constituencies.find((c) => c.code === v)?.wards[0]?.code ?? "");
                  }}
                  options={(county?.constituencies ?? []).map((c) => ({ value: c.code, label: c.name }))}
                />
              )}
              {position === "MCA" && (
                <Select
                  label="Ward"
                  value={wardCode}
                  onChange={setWardCode}
                  options={(constituency?.wards ?? []).map((w) => ({ value: w.code, label: w.name }))}
                />
              )}
            </div>
          )}

          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-forest">
              {position === "PRESIDENT" ? "Republic of Kenya · National tally" : (regional?.regionTitle ?? "Regional race")}
            </p>
            <h2 className="font-display mt-0.5 text-xl font-bold text-ink">{POSITION_LABELS[position]}</h2>
            <p className="mt-1 text-xs text-ink-soft">
              Valid votes: <strong className="text-ink">{(total ?? 0).toLocaleString()}</strong> · counted from the
              verified ledger
            </p>
          </div>

          {!rows ? (
            <div className="py-14 text-center text-ink-soft">
              <Loader2 className="mx-auto size-8 animate-spin text-forest" />
              <p className="mt-2 text-xs">Aggregating live ledger tallies…</p>
            </div>
          ) : rows.length === 0 ? (
            <p className="py-10 text-center text-sm text-ink-soft">
              No candidates found. Seed demo data on the{" "}
              <Link href="/setup" className="text-forest underline">
                Setup
              </Link>{" "}
              page.
            </p>
          ) : (
            <ol className="space-y-3">
              {rows.map((c, idx) => {
                const leader = idx === 0 && c.votes > 0;
                return (
                  <li
                    key={c.id}
                    className={`space-y-2.5 rounded-2xl border p-4 transition duration-500 ${
                      flash.has(c.id)
                        ? "border-forest bg-forest-soft ring-4 ring-forest/30"
                        : leader
                          ? "border-forest/40 bg-forest-soft"
                          : "border-line bg-paper"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <span
                          className={`grid size-7 shrink-0 place-items-center rounded-lg text-xs font-bold ${
                            leader ? "bg-forest text-white" : "bg-paper-2 text-ink-soft"
                          }`}
                        >
                          {idx + 1}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-bold text-ink">{c.name}</p>
                          <p className="flex items-center gap-1.5 text-xs text-ink-soft">
                            <span className="size-2 rounded-full" style={{ backgroundColor: c.partyColor }} />
                            {c.party}
                          </p>
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-xl font-bold tabular-nums text-ink">{c.percent}%</p>
                        <p className="text-xs tabular-nums text-ink-soft">
                          {c.votes.toLocaleString()} vote{c.votes === 1 ? "" : "s"}
                          {flash.has(c.id) && <span className="ml-1 font-bold text-forest">▲</span>}
                        </p>
                      </div>
                    </div>
                    <Bar percent={c.percent} color={c.partyColor || "#1f5a39"} thick />
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {/* Side column */}
        <aside className="space-y-6">
          <section className="glass space-y-4 p-5">
            <div>
              <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-forest">
                <SearchCheck className="size-4" /> Verify My Vote Receipt
              </p>
              <p className="mt-1 text-xs text-ink-soft">
                Enter the receipt code you got after voting to confirm it is sealed in the ledger.
              </p>
            </div>
            <ReceiptVerifier initialCode={receiptParam} compact />
            <Link href={receiptParam ? `/verify?code=${encodeURIComponent(receiptParam)}` : "/verify"} className="block text-xs text-ink-soft underline hover:text-ink">
              Open full cryptographic proof →
            </Link>
          </section>

          <section className="glass space-y-3 p-5">
            <p className="text-xs font-bold uppercase tracking-widest text-forest">Ballots by county</p>
            {data?.ballotsByCounty.length ? (
              <ul className="space-y-2 text-sm">
                {data.ballotsByCounty.slice(0, 8).map((c) => (
                  <li key={c.county} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-ink">{c.county}</span>
                      <span className="tabular-nums text-ink-soft">{c.ballots}</span>
                    </div>
                    <Bar percent={(c.ballots / Math.max(1, data.election.totalVotesCast)) * 100} color="#1f5a39" />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-ink-faint">No ballots yet.</p>
            )}
          </section>
        </aside>
      </div>

      <LedgerAuditPanel live={data?.audit ?? null} />
    </main>
  );
}

function Kpi(props: { label: string; value: string; sub: React.ReactNode; tone?: "good" | "bad"; icon?: React.ReactNode }) {
  const bad = props.tone === "bad";
  return (
    <div
      className={`glass flex flex-col justify-between gap-1 rounded-2xl p-4 ${
        bad ? "border-clay/60 bg-clay-soft" : props.tone === "good" ? "border-forest/30 bg-forest-soft" : ""
      }`}
    >
      <span className={`flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide ${bad ? "text-clay" : "text-ink-soft"}`}>
        {props.icon} {props.label}
      </span>
      <span className={`text-2xl font-bold tabular-nums ${bad ? "text-clay" : "text-ink"}`}>{props.value}</span>
      <span className="text-[11px] text-ink-soft">{props.sub}</span>
    </div>
  );
}

function Bar({ percent, color, thick }: { percent: number; color: string; thick?: boolean }) {
  return (
    <div className={`w-full overflow-hidden rounded-full bg-paper-2 ${thick ? "h-3" : "mt-1 h-1.5"}`}>
      <div
        className="h-full rounded-full transition-[width] duration-700 ease-out"
        style={{ width: `${Math.min(100, Math.max(percent > 0 ? 2 : 0, percent))}%`, backgroundColor: color }}
      />
    </div>
  );
}

function Select(props: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <label className="block">
      <span className="field-label text-[11px]">{props.label}</span>
      <select className="field py-2 text-sm" value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function PageSpinner() {
  return (
    <main className="grid min-h-[60dvh] place-items-center">
      <Loader2 className="size-8 animate-spin text-forest" />
    </main>
  );
}
