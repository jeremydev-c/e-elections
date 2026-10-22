"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Fingerprint, Loader2, Pause, Play, RefreshCw, SearchCheck, ShieldAlert, ShieldCheck } from "lucide-react";
import { PageTitle } from "@/components/Brand";
import { LedgerAuditPanel, type LiveAudit } from "@/components/LedgerAuditPanel";
import { ReceiptVerifier } from "@/components/ReceiptVerifier";
import { useToast } from "@/components/Toast";
import { useI18n } from "@/lib/i18n/I18n";
import { POSITIONS, type Position } from "@/lib/positions";
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
  const { t, serverText, regionText, locale } = useI18n();
  const num = (n: number) => n.toLocaleString(locale);

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
        position === "PRESIDENT" ? null : fetch(`/api/results/region?position=${position}&regionCode=${regionCode}`, { cache: "no-store" });

      const res = await overviewReq;
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setData(d);
      setLoadError("");
      setLastUpdated(Date.now());

      if (prevIntact.current && !d.audit.ledgerIntact) {
        toast.error(t("results.toastTamperTitle"), t("results.toastTamperBody"));
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
      setLoadError(serverText((err as Error).message));
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, [position, regionCode, markChanges, toast, t, serverText]);

  // Initial load + whenever the race / region changes.
  useEffect(() => {
    const id = setTimeout(refresh, 0);
    return () => clearTimeout(id);
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
  const intact = !data || data.audit.ledgerIntact;
  const status = data?.election.status;

  return (
    <main className="mx-auto min-h-dvh max-w-6xl space-y-8 px-4 py-12">
      <PageTitle eyebrow={t("results.eyebrow")} title={t("results.title")}>
        <div className="flex items-center gap-2 text-xs">
          <span className="flex items-center gap-2 whitespace-nowrap rounded-full border border-line-strong px-3 py-1.5 font-mono uppercase tracking-wider text-ink-soft">
            <span className={`size-2 rounded-full ${autoRefresh ? "animate-pulse bg-clay" : "bg-ink-faint"}`} />
            {autoRefresh ? t("results.live") : t("results.paused")}
            {secondsAgo !== null && <span className="normal-case tracking-normal text-ink-faint">· {t("common.secondsAgo", { s: secondsAgo })}</span>}
          </span>
          <button
            onClick={() => setAutoRefresh((v) => !v)}
            className="btn-ghost p-2"
            title={autoRefresh ? t("results.pause") : t("results.resume")}
            aria-label={autoRefresh ? t("results.pause") : t("results.resume")}
          >
            {autoRefresh ? <Pause className="size-4" /> : <Play className="size-4" />}
          </button>
          <button
            onClick={() => {
              setRefreshing(true);
              refresh();
            }}
            className="btn-ghost p-2"
            title={t("results.refreshNow")}
            aria-label={t("results.refreshNow")}
          >
            <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
          </button>
        </div>
      </PageTitle>

      {loadError && (
        <p role="alert" className="rounded-xl border border-ochre/40 bg-ochre-soft p-3.5 text-sm text-ochre-deep">
          {t("results.unreachable", { error: loadError })}{" "}
          <Link href="/setup" className="underline">
            {t("results.checkSetup")}
          </Link>
        </p>
      )}

      {/* Figures */}
      <section className="grid grid-cols-2 overflow-hidden rounded-2xl border border-line lg:grid-cols-4">
        <Figure
          label={t("results.status")}
          value={status ? (t(`results.statusValues.${status}`) ?? status) : "…"}
          sub={data?.election.name ?? t("results.defaultName")}
        />
        <Figure label={t("results.turnout")} value={`${data?.election.turnoutPercent ?? 0}%`} sub={<Bar percent={data?.election.turnoutPercent ?? 0} color="#0b5d3b" />} />
        <Figure
          label={t("results.ballotsCast")}
          value={num(data?.election.totalVotesCast ?? 0)}
          sub={t("results.ofRegistered", { n: num(data?.election.totalRegistered ?? 0) })}
        />
        <Figure
          label={t("results.integrity")}
          tone={intact ? "good" : "bad"}
          value={!data ? "…" : intact ? t("results.intact") : t("results.tampered")}
          sub={t("results.verifiedCount", { n: num(data?.audit.blocksVerified ?? 0) })}
          icon={intact ? <ShieldCheck className="size-4" /> : <ShieldAlert className="size-4" />}
        />
      </section>

      {data?.audit.merkleRoot && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-ink-soft">
          <Fingerprint className="size-4 text-forest" aria-hidden />
          <span className="uppercase tracking-wider text-ink-faint">{t("results.fingerprint")}</span>
          <span className="break-all text-ink">{data.audit.merkleRoot}</span>
          <span className="text-ink-faint">· {t("results.chains", { n: data.audit.chains })}</span>
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        {/* Races */}
        <section className="glass space-y-6 p-6 sm:p-8">
          <div className="flex flex-wrap gap-1.5">
            {POSITIONS.map((pos) => (
              <button
                key={pos}
                onClick={() => setPosition(pos)}
                aria-pressed={position === pos}
                className={`rounded-full px-3.5 py-1.5 text-sm transition ${
                  position === pos ? "bg-ink font-semibold text-paper" : "text-ink-soft hover:bg-paper-2 hover:text-ink"
                }`}
              >
                {t(`positions.${pos}`)}
              </button>
            ))}
          </div>

          {position !== "PRESIDENT" && (
            <div className="grid gap-3 rounded-xl border border-line p-4 sm:grid-cols-3">
              <Select
                label={t("common.county")}
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
                  label={t("common.constituency")}
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
                  label={t("common.ward")}
                  value={wardCode}
                  onChange={setWardCode}
                  options={(constituency?.wards ?? []).map((w) => ({ value: w.code, label: w.name }))}
                />
              )}
            </div>
          )}

          <div className="border-b border-line pb-5">
            <p className="eyebrow">
              {position === "PRESIDENT" ? t("results.nationalTally") : regional ? regionText(regional.regionTitle) : t("results.regionalRace")}
            </p>
            <h2 className="mt-2 font-display text-4xl text-ink">{t(`positions.${position}`)}</h2>
            <p className="mt-1 text-sm text-ink-soft">{t("results.validVotes", { n: num(total ?? 0) })}</p>
          </div>

          {!rows ? (
            <div className="py-14 text-center text-ink-soft">
              <Loader2 className="mx-auto size-8 animate-spin text-forest" />
              <p className="mt-3 text-sm">{t("results.aggregating")}</p>
            </div>
          ) : rows.length === 0 ? (
            <p className="py-10 text-center text-ink-soft">
              {t("results.noCandidates")}{" "}
              <Link href="/setup" className="text-forest underline">
                {t("results.setupPage")}
              </Link>
              .
            </p>
          ) : (
            <ol className="space-y-5">
              {rows.map((c, idx) => {
                const leader = idx === 0 && c.votes > 0;
                return (
                  <li key={c.id} className={`rounded-xl transition duration-500 ${flash.has(c.id) ? "bg-forest-soft ring-4 ring-forest-soft" : ""}`}>
                    <div className="flex items-end justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <span className={`font-display text-3xl leading-none ${leader ? "text-forest" : "text-line-strong"}`}>{idx + 1}</span>
                        <div className="min-w-0">
                          <p className="truncate text-lg font-semibold text-ink">{c.name}</p>
                          <p className="flex items-center gap-1.5 text-sm text-ink-soft">
                            <span className="size-2 rounded-full" style={{ backgroundColor: c.partyColor }} />
                            {c.party}
                          </p>
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="font-display text-4xl leading-none tabular-nums text-ink">{c.percent}%</p>
                        <p className="mt-1 font-mono text-xs tabular-nums text-ink-soft">
                          {t(c.votes === 1 ? "results.vote" : "results.votes", { n: num(c.votes) })}
                          {flash.has(c.id) && <span className="ml-1 text-forest">▲</span>}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3">
                      <Bar percent={c.percent} color={c.partyColor || "#0b5d3b"} thick />
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {/* Side column */}
        <aside className="space-y-6">
          <section className="glass space-y-4 p-6">
            <div>
              <p className="eyebrow flex items-center gap-2">
                <SearchCheck className="size-4 text-forest" /> {t("results.verifyTitle")}
              </p>
              <p className="mt-2 text-sm text-ink-soft">{t("results.verifyText")}</p>
            </div>
            <ReceiptVerifier initialCode={receiptParam} compact />
            <Link
              href={receiptParam ? `/verify?code=${encodeURIComponent(receiptParam)}` : "/verify"}
              className="block text-sm text-ink-soft underline underline-offset-4 hover:text-ink"
            >
              {t("results.fullProof")}
            </Link>
          </section>

          <section className="glass space-y-4 p-6">
            <p className="eyebrow">{t("results.byCounty")}</p>
            {data?.ballotsByCounty.length ? (
              <ul className="space-y-3 text-sm">
                {data.ballotsByCounty.slice(0, 8).map((c) => (
                  <li key={c.county} className="space-y-1.5">
                    <div className="flex justify-between">
                      <span className="text-ink">{c.county}</span>
                      <span className="font-mono tabular-nums text-ink-soft">{num(c.ballots)}</span>
                    </div>
                    <Bar percent={(c.ballots / Math.max(1, data.election.totalVotesCast)) * 100} color="#0b5d3b" />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-faint">{t("results.noBallots")}</p>
            )}
          </section>
        </aside>
      </div>

      <LedgerAuditPanel live={data?.audit ?? null} />
    </main>
  );
}

function Figure(props: { label: string; value: string; sub: React.ReactNode; tone?: "good" | "bad"; icon?: React.ReactNode }) {
  const bad = props.tone === "bad";
  return (
    <div className={`flex flex-col gap-2 border-line p-5 [&:not(:last-child)]:border-r max-lg:[&:nth-child(2)]:border-r-0 max-lg:[&:nth-child(-n+2)]:border-b ${bad ? "bg-clay-soft" : "bg-surface"}`}>
      <span className={`flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] ${bad ? "text-clay" : props.tone === "good" ? "text-forest" : "text-ink-faint"}`}>
        {props.icon} {props.label}
      </span>
      <span className={`font-display text-4xl leading-none tabular-nums ${bad ? "text-clay" : "text-ink"}`}>{props.value}</span>
      <span className="text-xs text-ink-soft">{props.sub}</span>
    </div>
  );
}

function Bar({ percent, color, thick }: { percent: number; color: string; thick?: boolean }) {
  return (
    <div className={`w-full overflow-hidden rounded-full bg-paper-2 ${thick ? "h-2.5" : "mt-1 h-1.5"}`}>
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
      <span className="field-label text-xs">{props.label}</span>
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
