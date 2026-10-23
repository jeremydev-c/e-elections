"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { platformAuthenticatorIsAvailable, startRegistration } from "@simplewebauthn/browser";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Fingerprint,
  IdCard,
  Loader2,
  Lock,
  LogOut,
  MapPin,
  Printer,
  ScanFace,
  ShieldCheck,
  Smartphone,
  TriangleAlert,
  UserPlus,
} from "lucide-react";
import { PageTitle } from "@/components/Brand";
import { FaceScan, preloadFaceScan, type Challenge, type FaceScanPayload } from "@/components/FaceScan";
import { AwsFaceScan, type AwsSession } from "@/components/AwsFaceScan";
import { useToast } from "@/components/Toast";
import { VoterCardBack, VoterCardFront, VoterCardPrintSheet, type VoterCardData } from "@/components/VoterCard";
import { useI18n } from "@/lib/i18n/I18n";
import { COUNTIES, getCounty, getWard } from "@/lib/regions";

/** "aws": faces are checked and stored by AWS Rekognition instead of the built-in engine. */
const FACE_PROVIDER = process.env.NEXT_PUBLIC_FACE_PROVIDER === "aws" ? "aws" : "local";

type Step = 1 | 2 | 3 | 4;
type Registered = {
  voterId: string;
  fullName: string;
  idNumber: string;
  phone?: string;
  countyCode?: string;
  constituencyCode?: string;
  wardCode?: string;
  photoDataUrl?: string;
};

const emptyForm = { fullName: "", idNumber: "", phone: "", countyCode: "", constituencyCode: "", wardCode: "" };

/** JSON request; on failure throws the server's message (in English: callers translate it). */
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export default function RegisterPage() {
  const { t } = useI18n();
  const [admin, setAdmin] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    preloadFaceScan();
    api<{ username: string | null }>("/api/admin/session")
      .then((d) => setAdmin(d.username))
      .catch(() => setAdmin(null));
  }, []);

  async function logout() {
    await fetch("/api/admin/session", { method: "DELETE" });
    setAdmin(null);
  }

  return (
    <main className="mx-auto min-h-dvh max-w-3xl px-4 py-12">
      <PageTitle eyebrow={t("register.eyebrow")} title={t("register.title")} lead={t("register.lead")}>
        {admin && (
          <button onClick={logout} id="admin-logout" className="btn-ghost px-4 py-2 text-sm" title={t("common.signOut")}>
            <LogOut className="size-4" aria-hidden /> {admin}
          </button>
        )}
      </PageTitle>

      {admin === undefined && (
        <div className="grid place-items-center py-24 text-ink-soft">
          <Loader2 className="size-8 animate-spin" aria-label={t("common.loading")} />
        </div>
      )}
      {admin === null && <AdminLogin onLogin={setAdmin} />}
      {admin && <RegistrationWizard />}
    </main>
  );
}

/* ------------------------------------------------------------------------ */

function AdminLogin({ onLogin }: { onLogin: (u: string) => void }) {
  const { t, serverText } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const d = await api<{ username: string }>("/api/admin/session", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      onLogin(d.username);
    } catch (err) {
      setError(serverText((err as Error).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="glass mx-auto max-w-md p-8 animate-fade-up sm:p-10">
      <div className="mb-7 text-center">
        <span className="mx-auto mb-5 grid size-14 place-items-center rounded-full bg-forest-soft">
          <Lock className="size-6 text-forest" aria-hidden />
        </span>
        <h2 className="font-display text-3xl text-ink">{t("register.loginTitle")}</h2>
        <p className="mt-2 text-sm text-ink-soft">{t("register.loginText")}</p>
        <p className="mt-2 text-xs text-ink-faint">
          {t("register.loginFirst")}{" "}
          <Link href="/setup" className="text-forest underline">
            {t("register.setupLink")}
          </Link>
          .
        </p>
      </div>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="admin-username" className="field-label">
            {t("common.username")}
          </label>
          <input id="admin-username" className="field" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </div>
        <div>
          <label htmlFor="admin-password" className="field-label">
            {t("common.password")}
          </label>
          <input
            id="admin-password"
            type="password"
            className="field"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && <ErrorBox msg={error} />}
        <button id="admin-login-submit" className="btn-primary w-full py-3.5" disabled={busy}>
          {busy ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <ShieldCheck className="size-5" aria-hidden />}
          {t("common.signIn")}
        </button>
      </form>
    </section>
  );
}

/* ------------------------------------------------------------------------ */

const STEPS = [
  { n: 1, key: "details", icon: IdCard },
  { n: 2, key: "face", icon: ScanFace },
  { n: 3, key: "passkey", icon: Fingerprint },
  { n: 4, key: "card", icon: CheckCircle2 },
] as const;

type ExistingVoterInfo = {
  fullName: string;
  idNumber: string;
  countyCode: string;
  constituencyCode: string;
  wardCode: string;
  registeredAt?: string;
};

type IdCheckState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "exists"; voter: ExistingVoterInfo }
  | { status: "available"; idNumber: string }
  | { status: "error"; msg: string };

function RegistrationWizard() {
  const { t, serverText } = useI18n();
  const [step, setStep] = useState<Step>(1);
  const [form, setForm] = useState(emptyForm);
  const [registered, setRegistered] = useState<Registered | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [idCheck, setIdCheck] = useState<IdCheckState>({ status: "idle" });
  const [checkingId, setCheckingId] = useState(false);
  const [platformSensor, setPlatformSensor] = useState<boolean | null>(null);
  const [card, setCard] = useState<VoterCardData | null>(null);
  const [cardError, setCardError] = useState("");
  const toast = useToast();

  // The printable card: card number and signed QR code come from the server.
  useEffect(() => {
    if (step !== 4 || !registered) return;
    let alive = true;
    api<Omit<VoterCardData, "photoDataUrl">>(`/api/voters/${registered.voterId}/card`)
      .then((d) => alive && setCard({ ...d, photoDataUrl: registered.photoDataUrl }))
      .catch((e) => alive && setCardError(serverText((e as Error).message) || t("card.failed")));
    return () => {
      alive = false;
    };
  }, [step, registered, serverText, t]);

  useEffect(() => {
    if (step !== 3) return;
    let alive = true;
    platformAuthenticatorIsAvailable()
      .then((ok) => alive && setPlatformSensor(ok))
      .catch(() => alive && setPlatformSensor(false));
    return () => {
      alive = false;
    };
  }, [step]);

  const county = useMemo(() => COUNTIES.find((c) => c.code === form.countyCode), [form.countyCode]);
  const constituency = useMemo(() => county?.constituencies.find((c) => c.code === form.constituencyCode), [county, form.constituencyCode]);
  const ward = constituency?.wards.find((w) => w.code === form.wardCode);

  const set = (k: keyof typeof emptyForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({
      ...f,
      [k]: e.target.value,
      ...(k === "countyCode" && { constituencyCode: "", wardCode: "" }),
      ...(k === "constituencyCode" && { wardCode: "" }),
    }));

  // Check the register as soon as a 7-8 digit ID is typed (debounced).
  useEffect(() => {
    const cleanId = form.idNumber.trim();
    if (!/^\d{7,8}$/.test(cleanId)) return;

    let active = true;
    const timer = setTimeout(async () => {
      setIdCheck({ status: "checking" });
      try {
        const res = await api<{ exists: boolean; voter?: ExistingVoterInfo }>(`/api/voters?idNumber=${encodeURIComponent(cleanId)}`);
        if (!active) return;
        setIdCheck(res.exists && res.voter ? { status: "exists", voter: res.voter } : { status: "available", idNumber: cleanId });
      } catch (err) {
        if (!active) return;
        setIdCheck({ status: "error", msg: serverText((err as Error).message) });
      }
    }, 350);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [form.idNumber, serverText]);

  const isIdTaken = idCheck.status === "exists";
  const isCheckingId = idCheck.status === "checking" || checkingId;

  const detailsValid =
    form.fullName.trim().length >= 3 &&
    /^\d{7,8}$/.test(form.idNumber) &&
    !isIdTaken &&
    !isCheckingId &&
    /^(?:\+?254|0)?[17]\d{8}$/.test(form.phone.replace(/[\s-]/g, "")) &&
    !!form.wardCode;

  async function handleProceedToFace(e: React.FormEvent) {
    e.preventDefault();
    if (!detailsValid) return;

    // Hard pre-flight check before the face scan.
    setCheckingId(true);
    setError("");
    try {
      const res = await api<{ exists: boolean; voter?: ExistingVoterInfo }>(`/api/voters?idNumber=${encodeURIComponent(form.idNumber.trim())}`);
      if (res.exists && res.voter) {
        setIdCheck({ status: "exists", voter: res.voter });
        setError(t("register.duplicateError", { id: form.idNumber, name: res.voter.fullName }));
        return;
      }
      setIdCheck({ status: "available", idNumber: form.idNumber.trim() });
      setStep(2);
    } catch (err) {
      setError(serverText((err as Error).message));
    } finally {
      setCheckingId(false);
    }
  }

  /** A liveness challenge bound to the ID being registered (the server redeems it once). */
  function getChallenge() {
    return api<Challenge>("/api/auth/voter/liveness", { method: "POST", body: JSON.stringify({ idNumber: form.idNumber }) }).catch((err: Error) => {
      throw new Error(serverText(err.message));
    });
  }

  async function submitFace({ liveness, frames }: FaceScanPayload) {
    setBusy(true);
    setError("");
    try {
      const r = await api<Registered>("/api/voters", {
        method: "POST",
        body: JSON.stringify({ ...form, liveness, frames }),
      });
      setRegistered(r);
      toast.success(t("register.toastRegTitle"), t("register.toastRegBody", { name: r.fullName }));
      setStep(3);
    } catch (err) {
      const msg = serverText((err as Error).message);
      setError(msg);
      throw new Error(msg);
    } finally {
      setBusy(false);
    }
  }

  async function submitAwsFace(ticket: string) {
    setBusy(true);
    setError("");
    try {
      const r = await api<Registered>("/api/voters", {
        method: "POST",
        body: JSON.stringify({ ...form, awsTicket: ticket }),
      });
      setRegistered(r);
      toast.success(t("register.toastRegTitle"), t("register.toastRegBody", { name: r.fullName }));
      setStep(3);
    } catch (err) {
      setError(serverText((err as Error).message));
    } finally {
      setBusy(false);
    }
  }

  async function enrollPasskey(attachment: "platform" | "any" = "platform") {
    if (!registered) return;
    setBusy(true);
    setError("");
    try {
      const optionsJSON = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/api/webauthn/register/options", {
        method: "POST",
        body: JSON.stringify({ voterId: registered.voterId, attachment }),
      });
      const response = await startRegistration({ optionsJSON });
      await api("/api/webauthn/register/verify", {
        method: "POST",
        body: JSON.stringify({ voterId: registered.voterId, response }),
      });
      toast.success(t("register.toastFingerTitle"), t("register.toastFingerBody"));
      setStep(4);
    } catch (err) {
      const e = err as Error;
      setError(
        e.name === "NotAllowedError"
          ? t("register.fingerCancelled")
          : e.name === "InvalidStateError"
            ? t("register.fingerExists")
            : serverText(e.message)
      );
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setForm(emptyForm);
    setRegistered(null);
    setCard(null);
    setCardError("");
    setError("");
    setIdCheck({ status: "idle" });
    setStep(1);
  }

  return (
    <section className="space-y-7">
      {/* Stepper */}
      <ol className="grid grid-cols-4 gap-2" aria-label={t("register.progress")}>
        {STEPS.map(({ n, key, icon: Icon }) => {
          const state = step > n ? "done" : step === n ? "active" : "todo";
          return (
            <li key={n} className="flex flex-col gap-2">
              <span className={`h-1 rounded-full ${state === "todo" ? "bg-line" : state === "done" ? "bg-forest" : "bg-ink"}`} />
              <span className={`flex items-center gap-1.5 text-xs font-semibold ${state === "todo" ? "text-ink-faint" : "text-ink"}`}>
                <Icon className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{t(`register.steps.${key}`)}</span>
              </span>
            </li>
          );
        })}
      </ol>

      <div className="glass p-6 sm:p-9" key={step}>
        <div className="animate-fade-up">
          {step === 1 && (
            <form className="space-y-6" onSubmit={handleProceedToFace}>
              <div className="grid gap-5 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label htmlFor="reg-fullname" className="field-label">
                    {t("register.fullName")}
                  </label>
                  <input id="reg-fullname" className="field" value={form.fullName} onChange={set("fullName")} placeholder={t("register.fullNamePh")} required />
                </div>
                <div>
                  <label htmlFor="reg-id" className="field-label">
                    {t("common.nationalId")}
                  </label>
                  <div className="relative">
                    <input
                      id="reg-id"
                      className={`field font-mono tracking-wider transition-colors ${
                        isIdTaken ? "border-clay/80 bg-clay-soft text-clay focus:border-clay focus:ring-clay/20" : idCheck.status === "available" ? "border-forest/40" : ""
                      }`}
                      inputMode="numeric"
                      maxLength={8}
                      value={form.idNumber}
                      onChange={(e) => {
                        const nextId = e.target.value.replace(/\D/g, "");
                        setForm((f) => ({ ...f, idNumber: nextId }));
                        if (!/^\d{7,8}$/.test(nextId)) setIdCheck({ status: "idle" });
                      }}
                      placeholder="12345678"
                      required
                    />
                    {isCheckingId && (
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                        <Loader2 className="size-4 animate-spin text-forest" />
                      </span>
                    )}
                  </div>

                  {idCheck.status === "checking" && (
                    <p className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-soft">
                      <Loader2 className="size-3.5 animate-spin text-forest" /> {t("register.checkingRegister")}
                    </p>
                  )}
                  {idCheck.status === "available" && (
                    <p className="mt-1.5 flex items-center gap-1.5 text-xs text-forest">
                      <CheckCircle2 className="size-3.5" /> {t("register.idAvailable")}
                    </p>
                  )}
                  {idCheck.status === "exists" && (
                    <div className="mt-2 rounded-xl border border-clay/40 bg-clay-soft p-3 text-xs text-clay animate-fade-up">
                      <div className="flex items-start gap-2">
                        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                        <div className="space-y-1">
                          <p className="font-semibold">{t("register.idTaken")}</p>
                          <p className="text-ink-soft">
                            {t("register.enrolledTo")} <strong className="text-ink">{idCheck.voter.fullName}</strong>
                            {getWard(idCheck.voter.wardCode) && (
                              <span>
                                {" "}
                                ({t("region.ward", { name: getWard(idCheck.voter.wardCode)?.name ?? "" })},{" "}
                                {t("region.county", { name: getCounty(idCheck.voter.countyCode)?.name ?? "" })})
                              </span>
                            )}
                          </p>
                          <p className="font-medium">{t("register.duplicate")}</p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                <div>
                  <label htmlFor="reg-phone" className="field-label">
                    {t("common.phone")}
                  </label>
                  <input id="reg-phone" className="field" inputMode="tel" value={form.phone} onChange={set("phone")} placeholder="0712 345 678" required />
                </div>
              </div>

              <fieldset className="space-y-4 rounded-xl border border-line p-5">
                <legend className="eyebrow flex items-center gap-2 px-2">
                  <MapPin className="size-3.5 text-forest" aria-hidden /> {t("register.homeRegion")}
                </legend>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div>
                    <label htmlFor="reg-county" className="field-label">
                      {t("common.county")}
                    </label>
                    <select id="reg-county" className="field" value={form.countyCode} onChange={set("countyCode")} required>
                      <option value="">{t("register.selectCounty")}</option>
                      {COUNTIES.map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.code.padStart(3, "0")} · {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="reg-constituency" className="field-label">
                      {t("common.constituency")}
                    </label>
                    <select id="reg-constituency" className="field" value={form.constituencyCode} onChange={set("constituencyCode")} disabled={!county} required>
                      <option value="">{t("register.selectConstituency")}</option>
                      {county?.constituencies.map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="reg-ward" className="field-label">
                      {t("common.ward")}
                    </label>
                    <select id="reg-ward" className="field" value={form.wardCode} onChange={set("wardCode")} disabled={!constituency} required>
                      <option value="">{t("register.selectWard")}</option>
                      {constituency?.wards.map((w) => (
                        <option key={w.code} value={w.code}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </fieldset>

              {error && <ErrorBox msg={error} />}

              <div className="flex justify-end">
                <button id="reg-next-face" type="submit" className="btn-primary" disabled={!detailsValid || checkingId}>
                  {checkingId ? (
                    <>
                      <Loader2 className="size-5 animate-spin" aria-hidden /> {t("register.verifyingId")}
                    </>
                  ) : (
                    <>
                      {t("register.continueFace")} <ArrowRight className="size-5" aria-hidden />
                    </>
                  )}
                </button>
              </div>
            </form>
          )}

          {step === 2 && (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="font-display text-3xl text-ink">{t("register.faceTitle")}</h2>
                <p className="mt-1 text-sm text-ink-soft">
                  {form.fullName} · {form.idNumber} · {ward?.name}, {constituency?.name}, {county?.name}
                </p>
              </div>
              {FACE_PROVIDER === "aws" ? (
                <AwsFaceScan
                  startSession={() => api<AwsSession>("/api/face/aws-session", { method: "POST", body: JSON.stringify({ purpose: "enroll" }) })}
                  onComplete={submitAwsFace}
                  actionLabel={t("register.capture")}
                />
              ) : (
                <FaceScan getChallenge={getChallenge} onScan={submitFace} actionLabel={t("register.capture")} />
              )}
              {busy && (
                <p className="flex items-center justify-center gap-2 text-sm text-ink-soft">
                  <Loader2 className="size-4 animate-spin text-forest" aria-hidden /> {t("register.saving")}
                </p>
              )}
              {error && <ErrorBox msg={error} />}
              <button
                id="reg-back-details"
                className="btn-ghost"
                onClick={() => {
                  setError("");
                  setStep(1);
                }}
                disabled={busy}
              >
                <ArrowLeft className="size-4" aria-hidden /> {t("register.backDetails")}
              </button>
            </div>
          )}

          {step === 3 && registered && (
            <div className="space-y-7 text-center">
              {registered.photoDataUrl && (
                <div className="mx-auto flex w-fit items-center gap-3 rounded-full border border-line bg-paper py-1.5 pl-1.5 pr-5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={registered.photoDataUrl} alt={t("register.photoAlt")} className="size-11 rounded-full object-cover" />
                  <div className="text-left text-xs">
                    <p className="font-semibold text-ink">{registered.fullName}</p>
                    <p className="font-mono text-ink-soft">
                      {registered.idNumber} · {t("register.faceEnrolled")}
                    </p>
                  </div>
                </div>
              )}

              <div>
                <span className="mx-auto mb-5 grid size-20 place-items-center rounded-full bg-forest-soft animate-pulse-ring">
                  <Fingerprint className="size-10 text-forest" aria-hidden />
                </span>
                <h2 className="font-display text-3xl text-ink">{t("register.fingerTitle")}</h2>
                <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">{t("register.fingerText")}</p>
              </div>
              {platformSensor === null && (
                <p className="flex items-center justify-center gap-2 text-sm text-ink-soft">
                  <Loader2 className="size-4 animate-spin" /> {t("register.detecting")}
                </p>
              )}
              {platformSensor === true && (
                <p className="mx-auto max-w-md rounded-xl border border-forest/30 bg-forest-soft p-3.5 text-left text-sm text-forest">{t("register.sensorYes")}</p>
              )}
              {platformSensor === false && (
                <p className="mx-auto max-w-md rounded-xl border border-ochre/40 bg-ochre-soft p-3.5 text-left text-sm text-ochre-deep">{t("register.sensorNo")}</p>
              )}
              {error && <ErrorBox msg={error} />}
              <div className="flex flex-col justify-center gap-3 sm:flex-row">
                {platformSensor !== false ? (
                  <button id="reg-enroll-passkey" className="btn-primary" onClick={() => enrollPasskey("platform")} disabled={busy || platformSensor === null}>
                    {busy ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Fingerprint className="size-5" aria-hidden />}
                    {t("register.scanDevice")}
                  </button>
                ) : (
                  <button id="reg-enroll-phone" className="btn-primary" onClick={() => enrollPasskey("any")} disabled={busy}>
                    {busy ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Smartphone className="size-5" aria-hidden />}
                    {t("register.usePhone")}
                  </button>
                )}
                <button id="reg-skip-passkey" className="btn-ghost" onClick={() => setStep(4)} disabled={busy}>
                  {t("register.skip")}
                </button>
              </div>
            </div>
          )}

          {step === 4 && registered && (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="font-display text-3xl text-ink">{t("card.title")}</h2>
                <p className="mx-auto mt-2 max-w-lg text-sm text-ink-soft">{t("card.lead")}</p>
              </div>

              {card ? (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <VoterCardFront data={card} className="h-auto w-full drop-shadow-md" />
                    <VoterCardBack data={card} className="h-auto w-full drop-shadow-md" />
                  </div>
                  <p className="mx-auto max-w-lg text-center text-xs leading-relaxed text-ink-soft">{t("card.unique")}</p>
                  <VoterCardPrintSheet data={card} />
                </>
              ) : cardError ? (
                <ErrorBox msg={cardError} />
              ) : (
                <p className="flex items-center justify-center gap-2 py-10 text-sm text-ink-soft">
                  <Loader2 className="size-4 animate-spin" /> {t("card.loading")}
                </p>
              )}

              <div className="flex flex-col justify-center gap-3 sm:flex-row">
                <button type="button" id="reg-print-card" onClick={() => window.print()} className="btn-ghost" disabled={!card}>
                  <Printer className="size-4" aria-hidden /> {t("register.printCard")}
                </button>
                <button type="button" id="reg-another" className="btn-primary" onClick={reset}>
                  <UserPlus className="size-5" aria-hidden /> {t("register.another")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}


function ErrorBox({ msg }: { msg: string }) {
  return (
    <p role="alert" className="flex items-start gap-2.5 rounded-xl border border-clay/30 bg-clay-soft p-3.5 text-left text-sm text-clay">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {msg}
    </p>
  );
}
