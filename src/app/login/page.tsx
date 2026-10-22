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
import { useI18n } from "@/lib/i18n/I18n";

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
  const { t, list, serverText } = useI18n();

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
    if (!/^\d{7,8}$/.test(idNumber)) return setError(t("login.idInvalid"));

    setBusy(true);
    setError("");
    setDenied(null);
    try {
      const { ok, data } = await postJSON<{ voter: VoterProfile; hasVoted?: boolean }>("/api/auth/voter/lookup", {
        idNumber,
      });
      if (data.hasVoted) {
        setDenied(data.error ? serverText(data.error) : t("login.alreadyVoted"));
        toast.error(t("login.toastDoubleTitle"), t("login.toastDoubleBody", { id: idNumber }));
        return;
      }
      if (!ok) throw new Error(data.error ? serverText(data.error) : t("login.lookupFailed"));

      setVoter(data.voter);
      setMethod(null);
      toast.success(t("login.toastFoundTitle"), t("login.toastFoundBody", { name: data.voter.displayName }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onVerified(message: string) {
    setVerified(message);
    toast.success(t("login.toastVerifiedTitle"), t("login.toastVerifiedBody"));
    setTimeout(() => router.push("/ballot"), 800);
  }

  function onAuthError(message: string, hasVoted?: boolean) {
    if (hasVoted) {
      setDenied(message);
      reset();
      return;
    }
    setError(message);
    toast.error(t("login.toastFailedTitle"), message);
  }

  // ---- Stage 2A: face scan ---------------------------------------------------
  async function getLivenessChallenge(): Promise<Challenge> {
    if (!voter) throw new Error(t("login.enterIdFirst"));
    const { ok, data } = await postJSON<Challenge>("/api/auth/voter/liveness", { idNumber: voter.idNumber });
    if (!ok) throw new Error(data.error ? serverText(data.error) : t("login.livenessFailed"));
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
        const msg = data.error ? serverText(data.error) : t("login.faceFailed");
        onAuthError(msg, data.hasVoted);
        throw new Error(msg);
      }
      onVerified(t("login.faceMatched", { p: data.confidence ?? 0, s: seconds }));
    } finally {
      setBusy(false);
    }
  }

  // Voters enrolled through AWS Rekognition are scanned and matched by AWS.
  async function getAwsSession(): Promise<AwsSession> {
    if (!voter) throw new Error(t("login.enterIdFirst"));
    const { ok, data } = await postJSON<AwsSession>("/api/face/aws-session", { purpose: "login", idNumber: voter.idNumber });
    if (!ok) throw new Error(data.error ? serverText(data.error) : t("login.scanFailed"));
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
      if (!ok) return onAuthError(data.error ? serverText(data.error) : t("login.faceFailed"), data.hasVoted);
      onVerified(t("login.faceMatchedAws", { p: data.confidence ?? 0 }));
    } finally {
      setBusy(false);
    }
  }

  // ---- Stage 2B: fingerprint (WebAuthn) ---------------------------------------
  async function handleFingerprint() {
    if (!voter) return;
    setBusy(true);
    setError("");
    try {
      const opt = await postJSON<{ hasVoted?: boolean }>("/api/webauthn/login/options", { idNumber: voter.idNumber });
      if (!opt.ok) return onAuthError(opt.data.error ? serverText(opt.data.error) : t("login.fingerStartFailed"), opt.data.hasVoted);

      const response = await startAuthentication({
        optionsJSON: opt.data as unknown as Parameters<typeof startAuthentication>[0]["optionsJSON"],
      });
      const ver = await postJSON<{ hasVoted?: boolean }>("/api/webauthn/login/verify", {
        idNumber: voter.idNumber,
        response,
      });
      if (!ver.ok) return onAuthError(ver.data.error ? serverText(ver.data.error) : t("login.fingerFailed"), ver.data.hasVoted);
      onVerified(t("login.fingerVerified"));
    } catch (err) {
      const e = err as Error;
      onAuthError(e.name === "NotAllowedError" ? t("login.fingerCancelled") : serverText(e.message));
    } finally {
      setBusy(false);
    }
  }

  const before = list<{ title: string; text: string }>("login.before");
  const beforeIcons = [IdCard, ScanFace, MapPin];

  return (
    <main className="mx-auto min-h-dvh max-w-6xl px-4 py-12">
      <PageTitle
        eyebrow={t("login.eyebrow")}
        title={voter ? t("login.titleVerify") : t("login.titleId")}
        lead={voter ? t("login.leadVerify") : t("login.leadId")}
      />

      <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          {/* Double-vote alert */}
          {denied && (
            <div role="alert" className="mb-6 overflow-hidden rounded-2xl border border-clay bg-clay-soft animate-fade-up">
              <div className="flex items-center gap-2 bg-clay px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.16em] text-white">
                <ShieldAlert className="size-4" aria-hidden /> {t("login.alertTitle")}
              </div>
              <div className="space-y-2 p-5">
                <p className="text-lg font-semibold leading-snug text-clay">{denied}</p>
                <p className="text-sm text-clay/90">{t("login.alertBody")}</p>
                <div className="flex flex-wrap gap-4 pt-1 text-sm">
                  <Link href="/verify" className="font-semibold text-ink underline underline-offset-4">
                    {t("login.alertVerify")}
                  </Link>
                  <button onClick={() => setDenied(null)} className="text-clay underline underline-offset-4">
                    {t("common.dismiss")}
                  </button>
                </div>
              </div>
            </div>
          )}

          <section className="glass relative overflow-hidden p-6 sm:p-9">
            {/* Stage 1 */}
            {!voter && (
              <div className="space-y-7 animate-fade-up">
                <StageBadge n={1} label={t("login.stageId")} text={t("login.stage", { n: 1, label: t("login.stageId") })} />
                <form onSubmit={handleLookup} className="space-y-5">
                  <div>
                    <label htmlFor="auth-id" className="field-label">
                      {t("login.idLabel")}
                    </label>
                    <div className="relative">
                      <IdCard className="pointer-events-none absolute left-5 top-1/2 size-5 -translate-y-1/2 text-ink-faint" />
                      <input
                        id="auth-id"
                        className="field py-4 pl-14 text-center font-mono text-2xl tracking-[0.35em]"
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

                  <button id="auth-lookup-btn" type="submit" className="btn-primary w-full py-4 text-base" disabled={busy || idNumber.length < 7}>
                    {busy ? (
                      <>
                        <Loader2 className="size-5 animate-spin" aria-hidden /> {t("login.checking")}
                      </>
                    ) : (
                      <>
                        {t("login.check")} <ArrowRight className="size-5" aria-hidden />
                      </>
                    )}
                  </button>
                </form>

                <div className="grid gap-2 border-t border-line pt-5 text-sm text-ink-soft sm:grid-cols-2">
                  <span className="flex items-center gap-2">
                    <ShieldCheck className="size-4 shrink-0 text-forest" /> {t("login.doubleCheck")}
                  </span>
                  <Link href="/results" className="flex items-center gap-2 hover:text-ink sm:justify-end">
                    <BarChart3 className="size-4 text-forest" /> {t("login.viewResults")}
                  </Link>
                </div>
              </div>
            )}

            {/* Stage 2 */}
            {voter && (
              <div className="space-y-7 animate-fade-up">
                <StageBadge n={2} label={t("login.stageBio")} text={t("login.stage", { n: 2, label: t("login.stageBio") })} />

                <div className="flex items-center justify-between gap-3 border-y border-line py-4">
                  <div className="min-w-0">
                    <p className="font-display text-2xl leading-tight text-ink">{voter.displayName}</p>
                    <p className="mt-1 flex items-center gap-1.5 truncate font-mono text-xs text-ink-soft">
                      <MapPin className="size-3.5 shrink-0" />{" "}
                      {t("login.voterWhere", {
                        id: voter.idNumber,
                        ward: t("region.ward", { name: voter.ward ?? "" }),
                        county: t("region.county", { name: voter.county ?? "" }),
                      })}
                    </p>
                  </div>
                  <button onClick={reset} className="btn-ghost shrink-0 px-3.5 py-1.5 text-xs" disabled={busy}>
                    {t("login.changeId")}
                  </button>
                </div>

                {verified ? (
                  <div className="rounded-2xl border border-forest/30 bg-forest-soft p-7 text-center animate-fade-up">
                    <CheckCircle2 className="mx-auto mb-3 size-10 text-forest" />
                    <p className="text-lg font-semibold text-forest">{verified}</p>
                    <p className="mt-2 flex items-center justify-center gap-2 text-sm text-ink-soft">
                      <Loader2 className="size-4 animate-spin" /> {t("login.opening")}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label={t("login.methodGroup")}>
                      <ChoiceCard
                        active={method === "face"}
                        disabled={!voter.hasFace || busy}
                        onClick={() => {
                          setMethod("face");
                          setError("");
                        }}
                        icon={<ScanFace className="size-6" />}
                        title={t("login.faceTitle")}
                        desc={voter.hasFace ? t("login.faceDesc") : t("login.faceNone")}
                      />
                      <ChoiceCard
                        active={method === "fingerprint"}
                        disabled={!voter.hasPasskey || !webauthnOk || busy}
                        onClick={() => {
                          setMethod("fingerprint");
                          setError("");
                        }}
                        icon={<Fingerprint className="size-6" />}
                        title={t("login.fingerTitle")}
                        desc={!webauthnOk ? t("login.fingerUnsupported") : voter.hasPasskey ? t("login.fingerDesc") : t("login.fingerNone")}
                      />
                    </div>

                    {error && <ErrorBox msg={error} />}

                    {method === "face" && (
                      <div className="space-y-3 animate-fade-up">
                        {voter.faceProvider === "aws" ? (
                          <AwsFaceScan startSession={getAwsSession} onComplete={handleAwsFace} actionLabel={t("login.verifyFace")} />
                        ) : (
                          <FaceScan getChallenge={getLivenessChallenge} onScan={handleFace} actionLabel={t("login.verifyFace")} />
                        )}
                        {busy && (
                          <p className="flex items-center justify-center gap-2 text-sm text-ink-soft">
                            <Loader2 className="size-4 animate-spin text-forest" /> {t("login.comparing")}
                          </p>
                        )}
                      </div>
                    )}

                    {method === "fingerprint" && (
                      <div className="space-y-5 py-4 text-center animate-fade-up">
                        <span className="mx-auto grid size-24 place-items-center rounded-full border border-forest/40 bg-forest-soft text-forest animate-pulse-ring">
                          <Fingerprint className="size-11" />
                        </span>
                        <p className="mx-auto max-w-sm text-sm text-ink-soft">{t("login.fingerPrivacy")}</p>
                        <button onClick={handleFingerprint} disabled={busy} className="btn-primary mx-auto px-8 py-3.5">
                          {busy ? (
                            <>
                              <Loader2 className="size-5 animate-spin" /> {t("login.waitingSensor")}
                            </>
                          ) : (
                            <>
                              <Fingerprint className="size-5" /> {t("login.scanFinger")}
                            </>
                          )}
                        </button>
                      </div>
                    )}

                    {!method && <p className="text-center text-sm text-ink-faint">{t("login.chooseOne")}</p>}
                  </>
                )}

                <button type="button" onClick={reset} className="btn-ghost w-full text-sm" disabled={busy}>
                  <ArrowLeft className="size-4" /> {t("login.cancel")}
                </button>
              </div>
            )}
          </section>
        </div>

        <aside className="space-y-5 lg:sticky lg:top-28">
          <div className="rounded-2xl border border-line p-6">
            <p className="eyebrow">{t("login.beforeTitle")}</p>
            <ul className="mt-5 space-y-5 text-sm">
              {before.map(({ title, text }, i) => {
                const I = beforeIcons[i];
                return (
                  <li key={title} className="flex gap-3.5">
                    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-forest-soft text-forest">
                      <I className="size-4" aria-hidden />
                    </span>
                    <span>
                      <span className="block font-semibold text-ink">{title}</span>
                      <span className="text-ink-soft">{text}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="rounded-2xl bg-night p-7 text-paper/70">
            <ShieldCheck className="size-6 text-[#e8c167]" aria-hidden />
            <p className="mt-4 font-display text-[1.7rem] leading-tight text-paper">{t("login.secretTitle")}</p>
            <p className="mt-2 text-sm leading-relaxed">{t("login.secretText")}</p>
          </div>
        </aside>
      </div>
    </main>
  );
}

function StageBadge({ n, text }: { n: number; label: string; text: string }) {
  return (
    <div className="flex items-center gap-3">
      {[1, 2].map((i) => (
        <span
          key={i}
          className={`grid size-7 place-items-center rounded-full border font-mono text-[11px] ${
            i < n ? "border-forest bg-forest text-white" : i === n ? "border-ink bg-ink text-paper" : "border-line-strong text-ink-faint"
          }`}
        >
          {i < n ? <CheckCircle2 className="size-4" /> : i}
        </span>
      ))}
      <span className="eyebrow">{text}</span>
    </div>
  );
}

function ChoiceCard(props: { active: boolean; disabled: boolean; onClick: () => void; icon: React.ReactNode; title: string; desc: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.active}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`flex h-full flex-col items-start gap-4 rounded-2xl border p-5 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${
        props.active ? "border-ink bg-surface ring-1 ring-ink" : "border-line bg-paper hover:border-ink-faint"
      }`}
    >
      <span className={`grid size-11 place-items-center rounded-full ${props.active ? "bg-forest text-white" : "bg-forest-soft text-forest"}`}>
        {props.icon}
      </span>
      <span>
        <span className="block text-base font-semibold text-ink">{props.title}</span>
        <span className="mt-1 block text-sm leading-relaxed text-ink-soft">{props.desc}</span>
      </span>
    </button>
  );
}

function ErrorBox({ msg }: { msg: string }) {
  return (
    <p role="alert" className="flex items-start gap-2.5 rounded-xl border border-clay/30 bg-clay-soft p-3.5 text-left text-sm text-clay">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-clay" aria-hidden /> {msg}
    </p>
  );
}
