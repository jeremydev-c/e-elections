"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Copy, ExternalLink, Loader2, Lock, MapPin, Printer, ShieldCheck, Vote } from "lucide-react";
import { PageTitle } from "@/components/Brand";
import { useToast } from "@/components/Toast";
import { useI18n } from "@/lib/i18n/I18n";
import type { Position } from "@/lib/positions";

type CandidateOption = {
  id: string;
  name: string;
  party: string;
  partyColor: string;
  photoUrl?: string;
};

type BallotSection = {
  position: Position;
  title: string;
  regionLabel: string;
  candidates: CandidateOption[];
};

type CastResult = {
  ok: boolean;
  receiptCode: string;
  seq: number;
  previousHash: string;
  currentHash: string;
  timestamp: string;
  county: string;
};

export default function BallotPage() {
  const router = useRouter();
  const toast = useToast();
  const { t, serverText, regionText, locale } = useI18n();

  const [loading, setLoading] = useState(true);
  const [voter, setVoter] = useState<{
    fullName: string;
    countyName: string;
    constituencyName: string;
    wardName: string;
  } | null>(null);

  const [ballots, setBallots] = useState<BallotSection[]>([]);
  const [activeSeatIdx, setActiveSeatIdx] = useState(0);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [reviewMode, setReviewMode] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [castResult, setCastResult] = useState<CastResult | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  // Load the voter session and the candidates for their region.
  useEffect(() => {
    async function init() {
      try {
        const res = await fetch("/api/ballot/candidates");
        if (res.status === 401) {
          router.push("/login");
          return;
        }
        const text = await res.text();
        const data = text ? JSON.parse(text) : {};
        if (!res.ok) throw new Error(data.error ?? "Failed to load ballots.");

        setVoter(data.voter);
        setBallots(data.ballots);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }
    init();
  }, [router]);

  function handleSelectCandidate(position: Position, candidateId: string) {
    setChoices((prev) => ({ ...prev, [position]: candidateId }));
  }

  const allSeatsChosen = ballots.length > 0 && ballots.every((b) => !!choices[b.position]);
  const currentBallot = ballots[activeSeatIdx];
  const seat = (p: Position) => t(`positions.${p}`);

  async function handleCastBallot() {
    if (!allSeatsChosen) return;
    setSubmitting(true);
    setError("");

    try {
      const res = await fetch("/api/cast-vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selections: choices }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ? serverText(data.error) : t("ballot.castFailed"));

      setCastResult(data);
      toast.success(t("ballot.toastSealedTitle"), t("ballot.toastSealedBody", { code: data.receiptCode, seq: data.seq }));
    } catch (err) {
      setError((err as Error).message);
      toast.error(t("ballot.toastNotCastTitle"), (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function copyReceipt(code: string) {
    navigator.clipboard?.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (loading) {
    return (
      <main className="mx-auto grid min-h-dvh place-items-center p-6 text-center">
        <div className="space-y-4">
          <Loader2 className="mx-auto size-10 animate-spin text-forest" />
          <h2 className="font-display text-3xl text-ink">{t("ballot.loadingTitle")}</h2>
          <p className="text-sm text-ink-soft">{t("ballot.loadingText")}</p>
        </div>
      </main>
    );
  }

  // --- Vote cast: the anonymous receipt ---
  if (castResult) {
    return (
      <main className="mx-auto min-h-dvh max-w-2xl px-4 py-12 animate-fade-up">
        <PageTitle eyebrow={t("ballot.doneEyebrow")} title={t("ballot.doneTitle")} />

        <section className="overflow-hidden rounded-2xl border border-line bg-surface">
          <div className="flag-bar h-1.5" aria-hidden />
          <div className="space-y-4 border-b border-line p-7 text-center sm:p-9">
            <span className="mx-auto grid size-16 place-items-center rounded-full bg-forest text-white">
              <CheckCircle2 className="size-8" />
            </span>
            <p className="eyebrow inline-flex items-center gap-2 text-forest">
              <ShieldCheck className="size-4" /> {t("ballot.sealedBadge")}
            </p>
            <h2 className="font-display text-4xl text-ink">{t("ballot.doneHeading")}</h2>
            <p className="mx-auto max-w-md text-[15px] leading-relaxed text-ink-soft">{t("ballot.doneText")}</p>
          </div>

          <div className="space-y-5 p-7 sm:p-9">
            <div className="rounded-xl border border-dashed border-line-strong p-5 text-center">
              <p className="eyebrow">{t("ballot.receiptCode")}</p>
              <p className="mt-2 font-mono text-2xl font-medium tracking-[0.12em] text-ink">{castResult.receiptCode}</p>
              <button onClick={() => copyReceipt(castResult.receiptCode)} className="btn-ghost mt-4 px-4 py-1.5 text-xs">
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? t("common.copied") : t("common.copy")}
              </button>
            </div>

            <dl className="grid grid-cols-3 gap-4 font-mono text-xs">
              <div>
                <dt className="text-ink-faint">{t("ballot.block")}</dt>
                <dd className="mt-1 font-medium text-ink">#{castResult.seq}</dd>
              </div>
              <div>
                <dt className="text-ink-faint">{t("ballot.time")}</dt>
                <dd className="mt-1 font-medium text-ink">{new Date(castResult.timestamp).toLocaleTimeString(locale)}</dd>
              </div>
              <div>
                <dt className="text-ink-faint">{t("ballot.county")}</dt>
                <dd className="mt-1 truncate font-medium text-ink">{castResult.county}</dd>
              </div>
              <div className="col-span-3 overflow-hidden">
                <dt className="text-ink-faint">{t("ballot.prevHash")}</dt>
                <dd className="mt-1 truncate text-ink-soft">{castResult.previousHash}</dd>
              </div>
              <div className="col-span-3 overflow-hidden">
                <dt className="text-ink-faint">{t("ballot.thisHash")}</dt>
                <dd className="mt-1 truncate text-forest">{castResult.currentHash}</dd>
              </div>
            </dl>

            <Link href={`/verify?code=${encodeURIComponent(castResult.receiptCode)}`} className="btn-primary w-full py-4">
              <ShieldCheck className="size-4" /> {t("ballot.verifyCta")}
            </Link>
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => window.print()} className="btn-ghost w-full text-sm">
                <Printer className="size-4" /> {t("common.print")}
              </button>
              <Link href="/results" className="btn-ghost w-full text-sm">
                <ExternalLink className="size-4" /> {t("ballot.liveResults")}
              </Link>
            </div>
          </div>
        </section>
      </main>
    );
  }

  // --- Review ---
  if (reviewMode) {
    return (
      <main className="mx-auto min-h-dvh max-w-3xl px-4 py-12 animate-fade-up">
        <PageTitle eyebrow={t("ballot.reviewEyebrow")} title={t("ballot.reviewTitle")} lead={t("ballot.reviewLead")}>
          <button onClick={() => setReviewMode(false)} className="btn-ghost text-sm">
            <ArrowLeft className="size-4" /> {t("ballot.edit")}
          </button>
        </PageTitle>

        <ol className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {ballots.map((b, i) => {
            const selected = b.candidates.find((c) => c.id === choices[b.position]);
            return (
              <li key={b.position}>
                <button
                  onClick={() => {
                    setActiveSeatIdx(i);
                    setReviewMode(false);
                  }}
                  className="flex w-full items-center gap-5 p-5 text-left transition hover:bg-paper"
                >
                  <span className="font-display text-3xl leading-none text-line-strong">{String(i + 1).padStart(2, "0")}</span>
                  <span className="min-w-0 flex-1">
                    <span className="eyebrow block">
                      {seat(b.position)} · {regionText(b.regionLabel)}
                    </span>
                    <span className="mt-1 block truncate text-lg font-semibold text-ink">{selected?.name ?? t("ballot.noneSelected")}</span>
                    <span className="flex items-center gap-2 text-sm text-ink-soft">
                      <span className="size-2.5 rounded-full" style={{ backgroundColor: selected?.partyColor ?? "#85897d" }} />
                      {selected?.party}
                    </span>
                  </span>
                  <ArrowRight className="size-4 shrink-0 text-ink-faint" aria-hidden />
                </button>
              </li>
            );
          })}
        </ol>

        {error && <p className="mt-5 rounded-xl border border-clay/40 bg-clay-soft p-3.5 text-sm text-clay">{error}</p>}

        <div className="mt-5 flex items-start gap-3 rounded-2xl border border-ochre/40 bg-ochre-soft p-5 text-sm text-ochre-deep">
          <Lock className="mt-0.5 size-5 shrink-0" />
          <div>
            <p className="font-semibold">{t("ballot.commitTitle")}</p>
            <p className="mt-1 leading-relaxed">{t("ballot.commitText")}</p>
          </div>
        </div>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <button onClick={() => setReviewMode(false)} disabled={submitting} className="btn-ghost sm:w-1/3">
            {t("ballot.backToBallot")}
          </button>
          <button id="confirm-cast-btn" onClick={handleCastBallot} disabled={submitting} className="btn-primary flex-1 py-4 text-base">
            {submitting ? (
              <>
                <Loader2 className="size-5 animate-spin" /> {t("ballot.casting")}
              </>
            ) : (
              <>
                <Vote className="size-5" /> {t("ballot.cast")}
              </>
            )}
          </button>
        </div>
      </main>
    );
  }

  // --- The ballot: six seats ---
  return (
    <main className="mx-auto min-h-dvh max-w-4xl px-4 py-12">
      <PageTitle
        eyebrow={t("ballot.eyebrow")}
        title={voter ? t("ballot.greeting", { name: voter.fullName.split(" ")[0] }) : t("ballot.yourBallot")}
      />

      {voter && (
        <div className="mb-8 flex items-start gap-3 border-l-2 border-forest pl-4">
          <MapPin className="mt-0.5 size-5 shrink-0 text-forest" aria-hidden />
          <div>
            <p className="font-semibold text-ink">
              {t("ballot.routed", {
                ward: t("region.ward", { name: voter.wardName }),
                constituency: t("region.constituency", { name: voter.constituencyName }),
                county: t("region.county", { name: voter.countyName }),
              })}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-ink-soft">{t("ballot.routedText")}</p>
          </div>
        </div>
      )}

      {error && !reviewMode && (
        <p role="alert" className="mb-6 rounded-xl border border-clay/40 bg-clay-soft p-3.5 text-sm text-clay">
          {serverText(error)}
        </p>
      )}

      {/* Seat rail */}
      <nav className="mb-6" aria-label={t("ballot.seats")}>
        <ol className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {ballots.map((b, idx) => {
            const chosen = !!choices[b.position];
            const active = activeSeatIdx === idx;
            return (
              <li key={b.position}>
                <button
                  onClick={() => setActiveSeatIdx(idx)}
                  aria-current={active ? "step" : undefined}
                  className={`flex h-full w-full flex-col items-start gap-1.5 rounded-xl border p-3 text-left transition ${
                    active ? "border-ink bg-ink text-paper" : chosen ? "border-forest/40 bg-forest-soft text-forest" : "border-line text-ink-soft hover:border-ink-faint"
                  }`}
                >
                  <span className="flex w-full items-center justify-between font-mono text-[10px]">
                    {String(idx + 1).padStart(2, "0")}
                    {chosen && <Check className="size-3.5" />}
                  </span>
                  <span className="text-xs font-semibold leading-tight">{seat(b.position)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      {currentBallot && (
        <section className="glass overflow-hidden">
          <div className="flag-bar h-1" aria-hidden />
          <div className="space-y-7 p-6 sm:p-9">
            <div className="flex flex-col gap-2 border-b border-line pb-5 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="eyebrow">{t("ballot.seatOf", { n: activeSeatIdx + 1, region: regionText(currentBallot.regionLabel) })}</p>
                <h2 className="mt-2 font-display text-4xl text-ink">{seat(currentBallot.position)}</h2>
              </div>
              <span className="text-sm text-ink-soft">{t("ballot.selectOne")}</span>
            </div>

            <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label={seat(currentBallot.position)}>
              {currentBallot.candidates.map((cand) => {
                const selected = choices[currentBallot.position] === cand.id;
                return (
                  <button
                    key={cand.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => handleSelectCandidate(currentBallot.position, cand.id)}
                    className={`group relative flex items-center gap-4 overflow-hidden rounded-xl border p-5 text-left transition ${
                      selected ? "border-ink bg-surface ring-1 ring-ink" : "border-line bg-paper hover:border-ink-faint"
                    }`}
                  >
                    <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: cand.partyColor }} />
                    <span
                      className={`grid size-7 shrink-0 place-items-center rounded-full border-2 transition ${
                        selected ? "border-forest bg-forest text-white" : "border-line-strong"
                      }`}
                    >
                      {selected && <Check className="size-4" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-lg font-semibold text-ink">{cand.name}</span>
                      <span className="mt-0.5 flex items-center gap-2 text-sm text-ink-soft">
                        <span className="size-2.5 rounded-full" style={{ backgroundColor: cand.partyColor }} />
                        {cand.party}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center justify-between border-t border-line pt-6">
              <button onClick={() => setActiveSeatIdx((i) => Math.max(0, i - 1))} disabled={activeSeatIdx === 0} className="btn-ghost">
                <ArrowLeft className="size-4" /> <span className="hidden sm:inline">{t("ballot.previous")}</span>
              </button>
              {activeSeatIdx < ballots.length - 1 ? (
                <button onClick={() => setActiveSeatIdx((i) => Math.min(ballots.length - 1, i + 1))} className="btn-ink">
                  {t("ballot.nextSeat")} <ArrowRight className="size-4" />
                </button>
              ) : (
                <button id="review-ballots-btn" onClick={() => setReviewMode(true)} disabled={!allSeatsChosen} className="btn-primary px-6">
                  {t("ballot.review")} <CheckCircle2 className="size-4" />
                </button>
              )}
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
