"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Fingerprint,
  IdCard,
  Loader2,
  MapPin,
  ScanFace,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { PageTitle } from "@/components/Brand";
import { FaceScan, preloadFaceScan, type Challenge, type FaceScanPayload } from "@/components/FaceScan";
import { AwsFaceScan, type AwsSession } from "@/components/AwsFaceScan";
import { useToast } from "@/components/Toast";

type VoterProfile = {
  idNumber: string;
  displayName: string;
  county?: string;
  constituency?: string;
  ward?: string;
  hasFace: boolean;
  /** Which engine enrolled the face: AWS Rekognition or our own. */
  faceProvider?: "aws" | "local" | null;
  hasPasskey: boolean;
};

type Method = "face" | "fingerprint";

async function postJSON<T = Record<string, unknown>>(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  return { ok: res.ok, status: res.status, data };
}

export default function VoterLoginPage() {
  const router = useRouter();
  const toast = useToast();

  const [idNumber, setIdNumber] = useState("");
  const [voter, setVoter] = useState<VoterProfile | null>(null);
  const [method, setMethod] = useState<Method | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState("");
  // Only read in Stage 2, which is never server-rendered, so no hydration mismatch.
  const [webauthnOk] = useState(() => typeof window === "undefined" || browserSupportsWebAuthn());

  useEffect(() => {
    preloadFaceScan();
  }, []);

  function reset() {
    setVoter(null);
    setMethod(null);
    setError("");
    setVerified("");
  }

  // ---- Stage 1: National ID check (double-voting lockout) -------------------
  async function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{7,8}$/.test(idNumber)) return setError("National ID must be 7 or 8 digits.");

    setBusy(true);
    setError("");
    setDenied(null);
    try {
      const { ok, data } = await postJSON<{ voter: VoterProfile; hasVoted?: boolean }>("/api/auth/voter/lookup", {
        idNumber,
      });
      if (data.hasVoted) {
        setDenied(data.error ?? "ACCESS DENIED: this National ID has already voted.");
        toast.error("Double vote blocked", `National ID ${idNumber} has already voted.`);
        return;
      }
      if (!ok) throw new Error(data.error ?? "Voter lookup failed.");

      setVoter(data.voter);
      setMethod(null);
      toast.success("Voter found", `${data.voter.displayName}: choose how to verify.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onVerified(message: string) {
    setVerified(message);
    toast.success("Identity verified", "Loading your ballot…");
    setTimeout(() => router.push("/ballot"), 800);
  }

  function onAuthError(message: string, hasVoted?: boolean) {
    if (hasVoted) {
      setDenied(message);
      reset();
      return;
    }
    setError(message);
    toast.error("Verification failed", message);
  }

  // ---- Stage 2A: Face Recognition Unlock -----------------------------------
  async function getLivenessChallenge(): Promise<Challenge> {
    if (!voter) throw new Error("Enter your National ID first.");
    const { ok, data } = await postJSON<Challenge>("/api/auth/voter/liveness", { idNumber: voter.idNumber });
    if (!ok) throw new Error(data.error ?? "Could not start the liveness check.");
    return data;
  }

  /** The server checks the frames (liveness moves, one person) and matches the face. */
  async function handleFace({ liveness, frames, seconds }: FaceScanPayload) {
    if (!voter) return;
    setBusy(true);
    setError("");
    try {
      const { ok, data } = await postJSON<{ confidence?: number; hasVoted?: boolean }>("/api/auth/voter/face", {
        idNumber: voter.idNumber,
        liveness,
        frames,
      });
      if (!ok) {
        onAuthError(data.error ?? "Face verification failed.", data.hasVoted);
        throw new Error(data.error ?? "Face verification failed.");
      }
      onVerified(`Face matched (${data.confidence ?? 0}% similarity, scanned in ${seconds} s).`);
    } finally {
      setBusy(false);
    }
  }

  // Voters enrolled through AWS Rekognition are scanned and matched by AWS.
  async function getAwsSession(): Promise<AwsSession> {
    if (!voter) throw new Error("Enter your National ID first.");
    const { ok, data } = await postJSON<AwsSession>("/api/face/aws-session", { purpose: "login", idNumber: voter.idNumber });
    if (!ok) throw new Error(data.error ?? "Could not start the face scan.");
    return data;
  }

  async function handleAwsFace(ticket: string) {
    if (!voter) return;
    setBusy(true);
    setError("");
    try {
      const { ok, data } = await postJSON<{ confidence?: number; hasVoted?: boolean }>("/api/auth/voter/face", {
        idNumber: voter.idNumber,
        awsTicket: ticket,
      });
      if (!ok) return onAuthError(data.error ?? "Face verification failed.", data.hasVoted);
      onVerified(`Face matched (${data.confidence ?? 0}% similarity).`);
    } finally {
      setBusy(false);
    }
  }

  // ---- Stage 2B: Fingerprint Sensor Unlock (WebAuthn) -----------------------
  async function handleFingerprint() {
    if (!voter) return;
    setBusy(true);
    setError("");
    try {
      const opt = await postJSON<{ hasVoted?: boolean }>("/api/webauthn/login/options", { idNumber: voter.idNumber });
      if (!opt.ok) return onAuthError(opt.data.error ?? "Could not start fingerprint scan.", opt.data.hasVoted);

      const response = await startAuthentication({
        optionsJSON: opt.data as unknown as Parameters<typeof startAuthentication>[0]["optionsJSON"],
      });
      const ver = await postJSON<{ hasVoted?: boolean }>("/api/webauthn/login/verify", {
        idNumber: voter.idNumber,
        response,
      });
      if (!ver.ok) return onAuthError(ver.data.error ?? "Fingerprint verification failed.", ver.data.hasVoted);
      onVerified("Fingerprint verified by this device's secure sensor.");
    } catch (err) {
      const e = err as Error;
      onAuthError(
        e.name === "NotAllowedError"
          ? "Fingerprint scan was cancelled or timed out. Try again, or use Face Recognition."
          : e.message
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto min-h-dvh max-w-6xl px-4 py-10">
      <PageTitle
        eyebrow="Voter Verification"
        title={voter ? "Choose how to verify" : "Enter your National ID"}
        lead={
          voter
            ? "Use either method. Both prove it is really you without sending a password anywhere."
            : "We check the voter register first. If this ID has already voted, the ballot never opens."
        }
      />

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0">

      {/* PROMINENT DOUBLE-VOTE ALERT */}
      {denied && (
        <div
          role="alert"
          className="mb-6 overflow-hidden rounded-2xl border-2 border-clay bg-clay-soft shadow-sm animate-fade-up"
        >
          <div className="flex items-center gap-2 bg-clay px-5 py-2 text-xs font-black uppercase tracking-widest text-white">
            <ShieldAlert className="size-4" aria-hidden /> Security Alert · Single-Vote Lockout
          </div>
          <div className="flex items-start gap-4 p-5">
            <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-clay-soft text-clay">
              <ShieldAlert className="size-8" aria-hidden />
            </span>
            <div className="space-y-2">
              <p className="text-lg font-bold leading-snug text-clay">{denied}</p>
              <p className="text-xs text-clay">
                The attempt was blocked before any ballot was shown. Each National ID can cast exactly one ballot.
              </p>
              <div className="flex flex-wrap gap-3 pt-1 text-xs">
                <Link href="/results" className="font-semibold text-ink underline">
                  Verify a receipt on the ledger
                </Link>
                <button onClick={() => setDenied(null)} className="text-clay underline">
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <section className="glass relative overflow-hidden p-6 sm:p-8">
        {/* STAGE 1 */}
        {!voter && (
          <div className="space-y-6 animate-fade-up">
            <StageBadge n={1} label="ID check" />
            <form onSubmit={handleLookup} className="space-y-4">
              <div>
                <label htmlFor="auth-id" className="field-label">
                  National ID Number
                </label>
                <div className="relative">
                  <IdCard className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-ink-faint" />
                  <input
                    id="auth-id"
                    className="field pl-12 text-center font-mono text-xl tracking-[0.3em]"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={8}
                    value={idNumber}
                    onChange={(e) => {
                      setIdNumber(e.target.value.replace(/\D/g, ""));
                      setError("");
                    }}
                    placeholder="12345678"
                    autoFocus
                    required
                  />
                </div>
              </div>

              {error && <ErrorBox msg={error} />}

              <button
                id="auth-lookup-btn"
                type="submit"
                className="btn-primary w-full py-3.5"
                disabled={busy || idNumber.length < 7}
              >
                {busy ? (
                  <>
                    <Loader2 className="size-5 animate-spin" aria-hidden /> Checking voter register…
                  </>
                ) : (
                  <>
                    Check eligibility <ArrowRight className="size-5" aria-hidden />
                  </>
                )}
              </button>
            </form>

            <div className="grid gap-2 border-t border-line pt-4 text-xs text-ink-soft sm:grid-cols-2">
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="size-4 text-forest" /> Double voting is checked before any ballot opens
              </span>
              <Link href="/results" className="flex items-center gap-1.5 hover:text-ink sm:justify-end">
                <BarChart3 className="size-4 text-forest" /> View live results
              </Link>
            </div>
          </div>
        )}

        {/* STAGE 2 */}
        {voter && (
          <div className="space-y-6 animate-fade-up">
            <StageBadge n={2} label="Biometric verification" />

            <div className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-paper p-4">
              <div className="min-w-0">
                <p className="font-bold text-ink">{voter.displayName}</p>
                <p className="flex items-center gap-1 truncate text-xs text-ink-soft">
                  <MapPin className="size-3.5 shrink-0" /> ID {voter.idNumber} · {voter.ward} Ward, {voter.county}
                </p>
              </div>
              <button onClick={reset} className="btn-ghost shrink-0 px-3 py-1.5 text-xs" disabled={busy}>
                Change ID
              </button>
            </div>

            {verified ? (
              <div className="rounded-2xl border border-forest/30 bg-forest-soft p-6 text-center animate-fade-up">
                <CheckCircle2 className="mx-auto mb-2 size-10 text-forest" />
                <p className="font-semibold text-forest">{verified}</p>
                <p className="mt-1 flex items-center justify-center gap-2 text-xs text-ink-soft">
                  <Loader2 className="size-3.5 animate-spin" /> Opening your ballot…
                </p>
              </div>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Verification method">
                  <ChoiceCard
                    active={method === "face"}
                    disabled={!voter.hasFace || busy}
                    onClick={() => {
                      setMethod("face");
                      setError("");
                    }}
                    icon={<ScanFace className="size-7" />}
                    title="Option A · Face Recognition"
                    desc={voter.hasFace ? "Live camera scan matched against your enrolled 128-point face profile." : "No face profile enrolled for this ID."}
                  />
                  <ChoiceCard
                    active={method === "fingerprint"}
                    disabled={!voter.hasPasskey || !webauthnOk || busy}
                    onClick={() => {
                      setMethod("fingerprint");
                      setError("");
                    }}
                    icon={<Fingerprint className="size-7" />}
                    title="Option B · Fingerprint Sensor"
                    desc={
                      !webauthnOk
                        ? "This browser does not support biometric passkeys."
                        : voter.hasPasskey
                          ? "Touch ID / Windows Hello / Android fingerprint via WebAuthn."
                          : "No fingerprint enrolled for this ID. Use Face Recognition."
                    }
                  />
                </div>

                {error && <ErrorBox msg={error} />}

                {method === "face" && (
                  <div className="space-y-3 animate-fade-up">
                    {voter.faceProvider === "aws" ? (
                      <AwsFaceScan startSession={getAwsSession} onComplete={handleAwsFace} actionLabel="Verify Face" />
                    ) : (
                      <FaceScan getChallenge={getLivenessChallenge} onScan={handleFace} actionLabel="Verify Face" />
                    )}
                    {busy && (
                      <p className="flex items-center justify-center gap-2 text-sm text-ink-soft">
                        <Loader2 className="size-4 animate-spin text-forest" /> Comparing with the voter register…
                      </p>
                    )}
                  </div>
                )}

                {method === "fingerprint" && (
                  <div className="space-y-4 py-4 text-center animate-fade-up">
                    <span className="mx-auto grid size-24 place-items-center rounded-2xl border border-forest/40 bg-forest-soft text-forest animate-pulse-ring">
                      <Fingerprint className="size-12" />
                    </span>
                    <p className="mx-auto max-w-sm text-xs text-ink-soft">
                      Your fingerprint never leaves this device. The sensor signs a one-time challenge and only the
                      signature is checked against the public key stored at registration.
                    </p>
                    <button onClick={handleFingerprint} disabled={busy} className="btn-primary mx-auto px-8 py-3.5">
                      {busy ? (
                        <>
                          <Loader2 className="size-5 animate-spin" /> Waiting for sensor…
                        </>
                      ) : (
                        <>
                          <Fingerprint className="size-5" /> Scan Fingerprint
                        </>
                      )}
                    </button>
                  </div>
                )}

                {!method && (
                  <p className="text-center text-xs text-ink-faint">Select Option A or Option B to continue.</p>
                )}
              </>
            )}

            <button type="button" onClick={reset} className="btn-ghost w-full text-xs" disabled={busy}>
              <ArrowLeft className="size-4" /> Cancel and return to ID entry
            </button>
          </div>
        )}
      </section>
      </div>

      <aside className="space-y-5 lg:sticky lg:top-24">
        <div className="rounded-2xl border border-line bg-paper-2/60 p-6">
          <p className="eyebrow">Before you begin</p>
          <ul className="mt-4 space-y-4 text-sm">
            {[
              [IdCard, "Your National ID number", "7 or 8 digits, exactly as printed on your card."],
              [ScanFace, "Your face or your fingerprint", "Good light for the camera, or the phone you enrolled at registration."],
              [MapPin, "Nothing else", "Your county, constituency and ward ballot loads on its own, wherever you are."],
            ].map(([Icon, title, text]) => {
              const I = Icon as typeof IdCard;
              return (
                <li key={title as string} className="flex gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface text-forest ring-1 ring-line">
                    <I className="size-4" aria-hidden />
                  </span>
                  <span>
                    <span className="block font-semibold text-ink">{title as string}</span>
                    <span className="text-ink-soft">{text as string}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="rounded-2xl bg-forest-deep p-6 text-[#d6e2d4]">
          <ShieldCheck className="size-6 text-[#e9c77e]" aria-hidden />
          <p className="mt-3 font-display text-xl font-semibold text-paper">Your ballot stays secret.</p>
          <p className="mt-2 text-sm leading-relaxed">
            The ledger records your choices with an anonymous receipt code only. Your name and ID number are never
            stored next to your vote.
          </p>
        </div>
      </aside>
      </div>
    </main>
  );
}

function StageBadge({ n, label }: { n: number; label: string }) {
  return (
    <div className="flex items-center gap-3 text-xs font-semibold text-ink-soft">
      {[1, 2].map((i) => (
        <span
          key={i}
          className={`grid size-7 place-items-center rounded-full border text-[11px] ${
            i < n
              ? "border-forest bg-forest text-white"
              : i === n
                ? "border-forest bg-forest-soft text-forest"
                : "border-line text-ink-faint"
          }`}
        >
          {i < n ? <CheckCircle2 className="size-4" /> : i}
        </span>
      ))}
      <span className="uppercase tracking-wider">
        Stage {n} of 2 · {label}
      </span>
    </div>
  );
}

function ChoiceCard(props: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.active}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`flex h-full flex-col items-start gap-3 rounded-2xl border p-5 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${
        props.active
          ? "border-forest bg-forest-soft ring-2 ring-forest/40"
          : "border-line bg-paper hover:border-forest/40 hover:bg-paper-2"
      }`}
    >
      <span
        className={`grid size-12 place-items-center rounded-xl ${
          props.active ? "bg-forest text-white" : "bg-forest-soft text-forest"
        }`}
      >
        {props.icon}
      </span>
      <span>
        <span className="block font-bold text-ink">{props.title}</span>
        <span className="mt-1 block text-xs text-ink-soft">{props.desc}</span>
      </span>
    </button>
  );
}

function ErrorBox({ msg }: { msg: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-xl border border-clay/30 bg-clay-soft p-3 text-left text-sm text-clay">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-clay" aria-hidden /> {msg}
    </p>
  );
}
