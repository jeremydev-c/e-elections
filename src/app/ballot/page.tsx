"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  Lock,
  MapPin,
  Printer,
  ShieldCheck,
  Sparkles,
  Vote,
} from "lucide-react";
import { PageTitle } from "@/components/Brand";
import { useToast } from "@/components/Toast";
import { POSITION_LABELS, type Position } from "@/lib/positions";

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

  // Load voter session and tailored candidate lists
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
      if (!res.ok) throw new Error(data.error ?? "Failed to cast ballot.");

      setCastResult(data);
      toast.success("Ballot sealed", `Receipt ${data.receiptCode} · block #${data.seq}`);
    } catch (err) {
      setError((err as Error).message);
      toast.error("Ballot not cast", (err as Error).message);
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
          <Loader2 className="mx-auto size-12 animate-spin text-forest" />
          <h2 className="font-display text-xl font-semibold text-ink">Routing Your Regional Ballots…</h2>
          <p className="text-xs text-ink-soft">Verifying secure voting token and local candidate register</p>
        </div>
      </main>
    );
  }

  // --- VOTE CAST CONFIRMATION / ANONYMOUS RECEIPT ---
  if (castResult) {
    return (
      <main className="mx-auto min-h-dvh max-w-2xl px-4 py-8 sm:py-12 animate-fade-up">
        <PageTitle eyebrow="Official Digital Voting Receipt" title="Thank you for voting" />

        <section className="relative overflow-hidden rounded-2xl border border-line bg-linear-to-b from-surface to-paper p-6 sm:p-8 shadow-sm">
          <div className="flag-bar -mx-8 -mt-8 mb-6 h-2 w-[calc(100%+4rem)]" aria-hidden />

          {/* IEBC Verified Stamp */}
          <div className="text-center space-y-3 pb-6 border-b border-line">
            <span className="mx-auto grid size-20 place-items-center rounded-2xl border-2 border-forest bg-forest-soft text-forest shadow-sm ">
              <CheckCircle2 className="size-10" />
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-forest/40 bg-forest-soft px-3 py-1 text-xs font-bold text-forest uppercase tracking-wider">
              <ShieldCheck className="size-4" /> Ballot Sealed in Cryptographic Ledger
            </span>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Vote Successfully Cast!</h1>
            <p className="text-xs text-ink-soft max-w-md mx-auto">
              Your 6 constitutional ballots have been committed into the append-only SHA-256 block ledger.
              Under Article 86 of the Constitution of Kenya, your ballot is completely anonymous.
            </p>
          </div>

          {/* Cryptographic Receipt Card */}
          <div className="my-6 space-y-4 rounded-2xl border border-line bg-paper p-5 font-mono text-xs shadow-inner">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <span className="text-ink-soft font-sans font-semibold">ANONYMOUS RECEIPT CODE</span>
              <button
                onClick={() => copyReceipt(castResult.receiptCode)}
                className="btn-ghost flex items-center gap-1 py-1 px-2 text-xs text-forest font-sans"
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>

            <p className="text-center text-xl font-bold tracking-widest text-ink py-1">
              {castResult.receiptCode}
            </p>

            <div className="grid grid-cols-2 gap-3 pt-2 text-[11px] text-ink-soft border-t border-line">
              <div>
                <span className="block text-ink-faint">BLOCK SEQUENCE</span>
                <span className="font-semibold text-ink">#{castResult.seq}</span>
              </div>
              <div>
                <span className="block text-ink-faint">TIMESTAMP</span>
                <span className="font-semibold text-ink">{new Date(castResult.timestamp).toLocaleTimeString()}</span>
              </div>
              <div className="col-span-2 overflow-hidden">
                <span className="block text-ink-faint">PREVIOUS BLOCK HASH (CHAIN LINK)</span>
                <span className="block truncate text-[10px] text-ink-soft">{castResult.previousHash}</span>
              </div>
              <div className="col-span-2 overflow-hidden">
                <span className="block text-ink-faint">BLOCK SHA-256 HASH</span>
                <span className="truncate block text-[10px] text-forest">{castResult.currentHash}</span>
              </div>
            </div>
          </div>

          {/* Action Links */}
          <div className="space-y-3">
            <Link
              href={`/results?receipt=${encodeURIComponent(castResult.receiptCode)}`}
              className="btn-primary w-full py-3.5 flex items-center justify-center gap-2"
            >
              <Sparkles className="size-4" /> Verify My Vote on Public Ledger
            </Link>

            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => window.print()}
                className="btn-ghost w-full py-3 flex items-center justify-center gap-2 text-xs"
              >
                <Printer className="size-4" /> Print / Save
              </button>

              <Link
                href="/results"
                className="btn-ghost w-full py-3 flex items-center justify-center gap-2 text-xs text-forest"
              >
                <ExternalLink className="size-4" /> Live Results
              </Link>
            </div>
          </div>
        </section>
      </main>
    );
  }

  // --- BALLOT REVIEW SCREEN ---
  if (reviewMode) {
    return (
      <main className="mx-auto min-h-dvh max-w-3xl px-4 py-8 sm:py-12 animate-fade-up">
        <PageTitle eyebrow="Ballot Confirmation Review" title="Review your 6 choices">
          <button onClick={() => setReviewMode(false)} className="btn-ghost text-xs">
            <ArrowLeft className="size-4" /> Edit Choices
          </button>
        </PageTitle>

        <section className="glass p-6 sm:p-8 space-y-6 shadow-sm">
          <div className="flag-bar -mx-8 -mt-8 mb-6 h-2 w-[calc(100%+4rem)]" aria-hidden />

          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Review Your 6 Ballots</h1>
            <p className="mt-1 text-xs text-ink-soft">
              Please inspect your candidate selections across all six electoral positions before finalizing.
            </p>
          </div>

          <div className="space-y-3">
            {ballots.map((b) => {
              const selectedCandidate = b.candidates.find((c) => c.id === choices[b.position]);
              return (
                <div
                  key={b.position}
                  className="flex items-center justify-between rounded-2xl border border-line bg-paper p-4"
                >
                  <div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-forest">
                      {b.title} · {b.regionLabel}
                    </span>
                    <h3 className="text-base font-bold text-ink mt-0.5">
                      {selectedCandidate?.name ?? "No candidate selected"}
                    </h3>
                    <p className="text-xs text-ink-soft">{selectedCandidate?.party}</p>
                  </div>
                  <span
                    className="size-4 rounded-full"
                    style={{ backgroundColor: selectedCandidate?.partyColor ?? "#64748b" }}
                    title={selectedCandidate?.party}
                  />
                </div>
              );
            })}
          </div>

          {error && (
            <div className="rounded-xl border border-clay/40 bg-clay-soft p-3 text-xs text-clay">
              {error}
            </div>
          )}

          <div className="rounded-2xl border border-ochre/40 bg-ochre-soft p-4 text-xs text-ochre-deep flex items-start gap-3">
            <Lock className="size-5 shrink-0 text-ochre-deep mt-0.5" />
            <div>
              <p className="font-bold text-ochre-deep">Irrevocable Single-Vote Commitment</p>
              <p className="mt-0.5">
                Once you click &quot;Cast Secret Ballot&quot;, your single vote is locked atomically in MongoDB and
                recorded in the SHA-256 hash chain. Your name and ID are never stored with the ballot. You will not
                be able to vote again.
              </p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <button
              onClick={() => setReviewMode(false)}
              disabled={submitting}
              className="btn-ghost sm:w-1/3"
            >
              Back to Ballots
            </button>
            <button
              id="confirm-cast-btn"
              onClick={handleCastBallot}
              disabled={submitting}
              className="btn-primary flex-1 py-3.5 text-base"
            >
              {submitting ? (
                <>
                  <Loader2 className="size-5 animate-spin" /> Chaining Ballot to Ledger…
                </>
              ) : (
                <>
                  <Vote className="size-5" /> Cast Secret Ballot Now
                </>
              )}
            </button>
          </div>
        </section>
      </main>
    );
  }

  // --- MAIN BALLOT INTERFACE (6 SEATS) ---
  return (
    <main className="mx-auto min-h-dvh max-w-4xl px-4 py-8 sm:py-12">
      <PageTitle eyebrow="Official Digital Ballot · General Election 2027" title={voter ? `Karibu, ${voter.fullName.split(" ")[0]}` : "Your ballot"} />

      {voter && (
        <div className="mb-6 flex items-start gap-3 rounded-2xl border border-forest/30 bg-forest-soft p-4 text-sm">
          <MapPin className="mt-0.5 size-5 shrink-0 text-forest" aria-hidden />
          <div>
            <p className="font-semibold text-ink">
              Ballot routed to your registered region: {voter.wardName} Ward · {voter.constituencyName} Constituency ·{" "}
              {voter.countyName} County
            </p>
            <p className="mt-0.5 text-xs text-ink-soft">
              Your county, constituency and ward races load automatically alongside the national Presidential race, so
              you can vote from anywhere without travelling back to your registration centre.
            </p>
          </div>
        </div>
      )}

      {error && !reviewMode && (
        <p role="alert" className="mb-6 rounded-xl border border-clay/40 bg-clay-soft p-3 text-sm text-clay">
          {error}
        </p>
      )}

      {/* Seat Selection Tab Bar */}
      <nav className="mb-6" aria-label="Electoral seats">
        <div className="flex flex-wrap gap-2">
          {ballots.map((b, idx) => {
            const hasChosen = !!choices[b.position];
            const isActive = activeSeatIdx === idx;
            return (
              <button
                key={b.position}
                onClick={() => setActiveSeatIdx(idx)}
                className={`flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-xs font-semibold transition border ${
                  isActive
                    ? "border-forest bg-forest text-white font-bold shadow-lg"
                    : hasChosen
                      ? "border-forest/30 bg-forest-soft text-forest"
                      : "border-line bg-paper text-ink-soft hover:text-ink"
                }`}
              >
                <span>{POSITION_LABELS[b.position]}</span>
                {hasChosen && (
                  <span
                    className={`grid size-4 place-items-center rounded-full ${
                      isActive ? "bg-paper text-forest" : "bg-forest text-white"
                    }`}
                  >
                    <Check className="size-2.5" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Active Ballot Section */}
      {currentBallot && (
        <section className="glass relative overflow-hidden p-6 sm:p-8 shadow-sm space-y-6">
          <div className="flag-bar -mx-8 -mt-8 mb-6 h-2 w-[calc(100%+4rem)]" aria-hidden />

          {/* Seat Header */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-line pb-4">
            <div>
              <span className="text-xs font-bold tracking-widest uppercase text-forest">
                SEAT {activeSeatIdx + 1} OF 6 · {currentBallot.regionLabel}
              </span>
              <h2 className="font-display text-2xl font-semibold text-ink mt-0.5">{currentBallot.title}</h2>
            </div>
            <span className="text-xs text-ink-soft">
              Select one candidate to cast your vote
            </span>
          </div>

          {/* Candidate Grid */}
          <div className="grid gap-4 sm:grid-cols-2">
            {currentBallot.candidates.map((cand) => {
              const isSelected = choices[currentBallot.position] === cand.id;
              return (
                <button
                  key={cand.id}
                  type="button"
                  onClick={() => handleSelectCandidate(currentBallot.position, cand.id)}
                  className={`group relative flex items-start gap-4 rounded-2xl border p-5 text-left transition ${
                    isSelected
                      ? "border-forest bg-forest-soft shadow-sm  ring-2 ring-forest/50"
                      : "border-line bg-paper hover:border-line hover:bg-paper-2"
                  }`}
                >
                  {/* Party Color indicator stripe */}
                  <span
                    className="absolute left-0 inset-y-3 w-1.5 rounded-r"
                    style={{ backgroundColor: cand.partyColor }}
                  />

                  {/* Radio Indicator */}
                  <span
                    className={`grid size-6 shrink-0 place-items-center rounded-full border transition mt-0.5 ${
                      isSelected
                        ? "border-forest bg-forest text-white"
                        : "border-line bg-paper group-hover:border-line"
                    }`}
                  >
                    {isSelected && <Check className="size-3.5" />}
                  </span>

                  <div className="flex-1">
                    <h3 className="text-base font-bold text-ink group-hover:text-forest transition">
                      {cand.name}
                    </h3>
                    <div className="flex items-center gap-2 mt-1">
                      <span
                        className="size-2.5 rounded-full"
                        style={{ backgroundColor: cand.partyColor }}
                      />
                      <span className="text-xs text-ink-soft font-medium">{cand.party}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Stepper Navigation Controls */}
          <div className="flex items-center justify-between border-t border-line pt-6">
            <button
              onClick={() => setActiveSeatIdx((i) => Math.max(0, i - 1))}
              disabled={activeSeatIdx === 0}
              className="btn-ghost"
            >
              <ArrowLeft className="size-4" /> Previous Seat
            </button>

            {activeSeatIdx < ballots.length - 1 ? (
              <button
                onClick={() => setActiveSeatIdx((i) => Math.min(ballots.length - 1, i + 1))}
                className="btn-primary"
              >
                Next Seat <ArrowRight className="size-4" />
              </button>
            ) : (
              <button
                id="review-ballots-btn"
                onClick={() => setReviewMode(true)}
                disabled={!allSeatsChosen}
                className="btn-primary px-6"
              >
                Review All 6 Ballots <CheckCircle2 className="size-4" />
              </button>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
