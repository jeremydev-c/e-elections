"use client";

import { useEffect, useMemo, useState } from "react";
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
  Smartphone,
  QrCode,
  ShieldCheck,
  TriangleAlert,
  UserPlus,
} from "lucide-react";
import { PageTitle } from "@/components/Brand";
import { FaceScan, preloadFaceScan, type Challenge, type FaceScanPayload } from "@/components/FaceScan";
import { AwsFaceScan, type AwsSession } from "@/components/AwsFaceScan";

/** "aws": faces are checked and stored by AWS Rekognition while our own engine is improved. */
const FACE_PROVIDER = process.env.NEXT_PUBLIC_FACE_PROVIDER === "aws" ? "aws" : "local";
import { useToast } from "@/components/Toast";
import { COUNTIES, getCounty, getWard } from "@/lib/regions";

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
  const [admin, setAdmin] = useState<string | null | undefined>(undefined);

  // Preload face models in background as soon as page mounts
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
    <main className="mx-auto min-h-dvh max-w-3xl px-4 py-8">
      <PageTitle
        eyebrow="Voter Registration Portal"
        title="Register a voter"
        lead="National ID, home electoral region and biometric enrolment."
      >
        {admin && (
          <button onClick={logout} id="admin-logout" className="btn-ghost px-3 py-2 text-sm">
            <LogOut className="size-4" aria-hidden /> {admin}
          </button>
        )}
      </PageTitle>

      {admin === undefined && (
        <div className="grid place-items-center py-24 text-ink-soft">
          <Loader2 className="size-8 animate-spin" aria-label="Loading" />
        </div>
      )}
      {admin === null && <AdminLogin onLogin={setAdmin} />}
      {admin && <RegistrationWizard />}
    </main>
  );
}

/* ------------------------------------------------------------------------ */

function AdminLogin({ onLogin }: { onLogin: (u: string) => void }) {
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
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="glass mx-auto max-w-md p-8 animate-fade-up">
      <div className="mb-6 text-center">
        <span className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-forest-soft">
          <Lock className="size-7 text-forest" aria-hidden />
        </span>
        <h1 className="font-display text-2xl font-semibold text-ink">Election Official Login</h1>
        <p className="mt-1 text-sm text-ink-soft">Only authorised officials can register voters.</p>
        <p className="mt-2 text-xs text-ink-faint">
          First time? Create the official account on the <a href="/setup" className="text-forest underline">Setup</a> page.
        </p>
      </div>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="admin-username" className="field-label">Username</label>
          <input
            id="admin-username"
            className="field"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </div>
        <div>
          <label htmlFor="admin-password" className="field-label">Password</label>
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
        <button id="admin-login-submit" className="btn-primary w-full" disabled={busy}>
          {busy ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <ShieldCheck className="size-5" aria-hidden />}
          Sign in
        </button>
      </form>
    </section>
  );
}

/* ------------------------------------------------------------------------ */

const STEPS = [
  { n: 1, label: "Details", icon: IdCard },
  { n: 2, label: "Biometrics", icon: UserPlus },
  { n: 3, label: "Passkey", icon: Fingerprint },
  { n: 4, label: "Voter Card", icon: CheckCircle2 },
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
  const [step, setStep] = useState<Step>(1);
  const [form, setForm] = useState(emptyForm);
  const [registered, setRegistered] = useState<Registered | null>(null);
  const [passkeyAdded, setPasskeyAdded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [idCheck, setIdCheck] = useState<IdCheckState>({ status: "idle" });
  const [checkingId, setCheckingId] = useState(false);
  const [platformSensor, setPlatformSensor] = useState<boolean | null>(null);
  const toast = useToast();

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
  const constituency = useMemo(
    () => county?.constituencies.find((c) => c.code === form.constituencyCode),
    [county, form.constituencyCode]
  );
  const ward = constituency?.wards.find((w) => w.code === form.wardCode);

  const set = (k: keyof typeof emptyForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({
      ...f,
      [k]: e.target.value,
      ...(k === "countyCode" && { constituencyCode: "", wardCode: "" }),
      ...(k === "constituencyCode" && { wardCode: "" }),
    }));

  // Automatic debounced existence check whenever 7-8 digit ID is entered
  useEffect(() => {
    const cleanId = form.idNumber.trim();
    if (!/^\d{7,8}$/.test(cleanId)) return;

    let active = true;

    const timer = setTimeout(async () => {
      setIdCheck({ status: "checking" });
      try {
        const res = await api<{ exists: boolean; voter?: ExistingVoterInfo }>(
          `/api/voters?idNumber=${encodeURIComponent(cleanId)}`
        );
        if (!active) return;
        if (res.exists && res.voter) {
          setIdCheck({ status: "exists", voter: res.voter });
        } else {
          setIdCheck({ status: "available", idNumber: cleanId });
        }
      } catch (err) {
        if (!active) return;
        setIdCheck({ status: "error", msg: (err as Error).message });
      }
    }, 350);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [form.idNumber]);

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

    // Hard pre-flight check before advancing to step 2
    setCheckingId(true);
    setError("");

    try {
      const res = await api<{ exists: boolean; voter?: ExistingVoterInfo }>(
        `/api/voters?idNumber=${encodeURIComponent(form.idNumber.trim())}`
      );
      if (res.exists && res.voter) {
        setIdCheck({ status: "exists", voter: res.voter });
        setError(
          `National ID ${form.idNumber} is already registered to ${res.voter.fullName}. Duplicate registration is prohibited.`
        );
        return;
      }
      setIdCheck({ status: "available", idNumber: form.idNumber.trim() });
      setStep(2);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCheckingId(false);
    }
  }

  /** A liveness challenge bound to the ID being registered (the server redeems it once). */
  function getChallenge() {
    return api<Challenge>("/api/auth/voter/liveness", { method: "POST", body: JSON.stringify({ idNumber: form.idNumber }) });
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
      toast.success("Voter registered", `${r.fullName} saved to the central register.`);
      setStep(3);
    } catch (err) {
      setError((err as Error).message);
      throw err;
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
      toast.success("Voter registered", `${r.fullName} saved to the central register.`);
      setStep(3);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function enrollPasskey(attachment: "platform" | "any" = "platform") {
    if (!registered) return;
    setBusy(true);
    setError("");
    try {
      const optionsJSON = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
        "/api/webauthn/register/options",
        { method: "POST", body: JSON.stringify({ voterId: registered.voterId, attachment }) }
      );
      const response = await startRegistration({ optionsJSON });
      await api("/api/webauthn/register/verify", {
        method: "POST",
        body: JSON.stringify({ voterId: registered.voterId, response }),
      });
      setPasskeyAdded(true);
      toast.success("Fingerprint enrolled", "Only the public key was stored.");
      setStep(4);
    } catch (err) {
      const e = err as Error;
      setError(
        e.name === "NotAllowedError"
          ? "Fingerprint scan was cancelled or timed out."
          : e.name === "InvalidStateError"
            ? "This device already has a passkey for this voter."
            : e.message
      );
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setForm(emptyForm);
    setRegistered(null);
    setPasskeyAdded(false);
    setError("");
    setIdCheck({ status: "idle" });
    setStep(1);
  }

  return (
    <section className="space-y-6">

      {/* Stepper */}
      <ol className="grid grid-cols-4 gap-2" aria-label="Registration progress">
        {STEPS.map(({ n, label, icon: Icon }) => {
          const state = step > n ? "done" : step === n ? "active" : "todo";
          return (
            <li key={n} className="flex flex-col items-center gap-2 text-center">
              <span
                className={`grid size-10 place-items-center rounded-full border transition ${
                  state === "done"
                    ? "border-forest bg-forest text-white"
                    : state === "active"
                      ? "border-forest bg-forest-soft text-forest"
                      : "border-line bg-paper text-ink-faint"
                }`}
              >
                <Icon className="size-5" aria-hidden />
              </span>
              <span className={`text-xs font-medium ${state === "todo" ? "text-ink-faint" : "text-ink"}`}>
                {label}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="glass p-6 sm:p-8" key={step}>
        <div className="animate-fade-up">
          {step === 1 && (
            <form className="space-y-5" onSubmit={handleProceedToFace}>
              <div className="grid gap-5 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label htmlFor="reg-fullname" className="field-label">Full name (as on ID)</label>
                  <input
                    id="reg-fullname"
                    className="field"
                    value={form.fullName}
                    onChange={set("fullName")}
                    placeholder="e.g. Wanjiru Akinyi Kamau"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="reg-id" className="field-label">National ID number</label>
                  <div className="relative">
                    <input
                      id="reg-id"
                      className={`field font-mono tracking-wider transition-colors ${
                        isIdTaken
                          ? "border-clay/80 bg-clay-soft text-clay focus:border-clay focus:ring-clay/20"
                          : idCheck.status === "available"
                            ? "border-forest/30 focus:border-forest focus:ring-forest/20"
                            : ""
                      }`}
                      inputMode="numeric"
                      maxLength={8}
                      value={form.idNumber}
                      onChange={(e) => {
                        const nextId = e.target.value.replace(/\D/g, "");
                        setForm((f) => ({ ...f, idNumber: nextId }));
                        if (!/^\d{7,8}$/.test(nextId)) {
                          setIdCheck({ status: "idle" });
                        }
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

                  {/* ID Existence Indicators */}
                  {idCheck.status === "checking" && (
                    <p className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-soft">
                      <Loader2 className="size-3.5 animate-spin text-forest" />
                      Checking central voter register…
                    </p>
                  )}

                  {idCheck.status === "available" && (
                    <p className="mt-1.5 flex items-center gap-1.5 text-xs text-forest">
                      <CheckCircle2 className="size-3.5 text-forest" />
                      National ID is available for registration
                    </p>
                  )}

                  {idCheck.status === "exists" && (
                    <div className="mt-2 rounded-xl border border-clay/40 bg-clay-soft p-3 text-xs text-clay animate-fade-up">
                      <div className="flex items-start gap-2">
                        <TriangleAlert className="size-4 text-clay shrink-0 mt-0.5" />
                        <div className="space-y-1">
                          <p className="font-bold text-clay">
                            National ID already registered in database!
                          </p>
                          <p className="text-ink-soft">
                            Enrolled to: <strong className="text-ink">{idCheck.voter.fullName}</strong>
                            {getWard(idCheck.voter.wardCode) && (
                              <span className="text-ink-soft">
                                {" "}({getWard(idCheck.voter.wardCode)?.name} Ward, {getCounty(idCheck.voter.countyCode)?.name} County)
                              </span>
                            )}
                          </p>
                          <p className="text-[11px] text-clay font-medium">
                            ⚠️ Duplicate voter registration is strictly prohibited. You cannot proceed with this ID.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                <div>
                  <label htmlFor="reg-phone" className="field-label">Phone number</label>
                  <input
                    id="reg-phone"
                    className="field"
                    inputMode="tel"
                    value={form.phone}
                    onChange={set("phone")}
                    placeholder="0712 345 678"
                    required
                  />
                </div>
              </div>

              <fieldset className="space-y-4 rounded-2xl border border-line bg-paper p-4">
                <legend className="flex items-center gap-2 px-2 text-sm font-semibold text-forest">
                  <MapPin className="size-4" aria-hidden /> Home electoral region
                </legend>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div>
                    <label htmlFor="reg-county" className="field-label">County</label>
                    <select
                      id="reg-county"
                      className="field"
                      value={form.countyCode}
                      onChange={set("countyCode")}
                      required
                    >
                      <option value="">Select county</option>
                      {COUNTIES.map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.code.padStart(3, "0")} · {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="reg-constituency" className="field-label">Constituency</label>
                    <select
                      id="reg-constituency"
                      className="field"
                      value={form.constituencyCode}
                      onChange={set("constituencyCode")}
                      disabled={!county}
                      required
                    >
                      <option value="">Select constituency</option>
                      {county?.constituencies.map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="reg-ward" className="field-label">Ward</label>
                    <select
                      id="reg-ward"
                      className="field"
                      value={form.wardCode}
                      onChange={set("wardCode")}
                      disabled={!constituency}
                      required
                    >
                      <option value="">Select ward</option>
                      {constituency?.wards.map((w) => (
                        <option key={w.code} value={w.code}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </fieldset>

              <div className="flex justify-end">
                <button
                  id="reg-next-face"
                  type="submit"
                  className="btn-primary"
                  disabled={!detailsValid || checkingId}
                >
                  {checkingId ? (
                    <>
                      <Loader2 className="size-5 animate-spin" aria-hidden /> Verifying National ID…
                    </>
                  ) : (
                    <>
                      Continue to face scan <ArrowRight className="size-5" aria-hidden />
                    </>
                  )}
                </button>
              </div>
            </form>
          )}

          {step === 2 && (
            <div className="space-y-5">
              <div className="text-center">
                <h2 className="font-display text-xl font-semibold text-ink">Biometric Face Enrollment</h2>
                <p className="text-sm text-ink-soft">
                  {form.fullName} · ID {form.idNumber} · {ward?.name}, {constituency?.name}, {county?.name}
                </p>
              </div>
              {FACE_PROVIDER === "aws" ? (
                <AwsFaceScan
                  startSession={() => api<AwsSession>("/api/face/aws-session", { method: "POST", body: JSON.stringify({ purpose: "enroll" }) })}
                  onComplete={submitAwsFace}
                  actionLabel="Capture & Enroll"
                />
              ) : (
                <FaceScan getChallenge={getChallenge} onScan={submitFace} actionLabel="Capture & Enroll" />
              )}
              {busy && (
                <p className="flex items-center justify-center gap-2 text-sm text-ink-soft">
                  <Loader2 className="size-4 animate-spin text-forest" aria-hidden /> Saving voter to central registry…
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
                <ArrowLeft className="size-4" aria-hidden /> Back to Details
              </button>
            </div>
          )}

          {step === 3 && registered && (
            <div className="space-y-6 text-center">
              {/* Voter Mini Card Header */}
              {registered.photoDataUrl && (
                <div className="mx-auto flex w-fit items-center gap-3 rounded-2xl border border-line bg-paper p-2 pr-4 shadow-lg">
                  <div className="relative size-12 overflow-hidden rounded-xl border border-forest/50">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={registered.photoDataUrl}
                      alt="Enrolled Voter Photo"
                      className="h-full w-full object-cover"
                    />
                  </div>
                  <div className="text-left text-xs">
                    <p className="font-bold text-ink">{registered.fullName}</p>
                    <p className="font-mono text-ink-soft">ID: {registered.idNumber} · Face Enrolled ✓</p>
                  </div>
                </div>
              )}

              <div>
                <span className="mx-auto mb-4 grid size-20 place-items-center rounded-full bg-forest-soft animate-pulse-ring">
                  <Fingerprint className="size-10 text-forest" aria-hidden />
                </span>
                <h2 className="font-display text-xl font-semibold text-ink">Fingerprint Unlock (Device Passkey)</h2>
                <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">
                  Optional hardware link. Uses this device&apos;s biometric sensor. Only the public cryptographic key is
                  stored in MongoDB.
                </p>
              </div>
              {platformSensor === null && (
                <p className="flex items-center justify-center gap-2 text-xs text-ink-soft">
                  <Loader2 className="size-3.5 animate-spin" /> Detecting fingerprint hardware…
                </p>
              )}
              {platformSensor === true && (
                <p className="mx-auto max-w-md rounded-xl border border-forest/30 bg-forest-soft p-3 text-left text-xs text-forest">
                  <strong>Sensor detected.</strong> The fingerprint is bound to <em>this device</em>. On any other device
                  the voter verifies with <strong>Face Recognition</strong> instead.
                </p>
              )}
              {platformSensor === false && (
                <p className="mx-auto max-w-md rounded-xl border border-ochre/40 bg-ochre-soft p-3 text-left text-xs text-ochre-deep">
                  <strong>No built-in fingerprint sensor on this device.</strong> You can enroll the voter&apos;s own phone
                  (scan the QR code the browser shows) or a USB security key, or skip: the voter can still use Face
                  Recognition.
                </p>
              )}
              {error && <ErrorBox msg={error} />}
              <div className="flex flex-col justify-center gap-3 sm:flex-row">
                {platformSensor !== false ? (
                  <button id="reg-enroll-passkey" className="btn-primary" onClick={() => enrollPasskey("platform")} disabled={busy || platformSensor === null}>
                    {busy ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Fingerprint className="size-5" aria-hidden />}
                    Scan Device Fingerprint
                  </button>
                ) : (
                  <button id="reg-enroll-phone" className="btn-primary" onClick={() => enrollPasskey("any")} disabled={busy}>
                    {busy ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Smartphone className="size-5" aria-hidden />}
                    Use Phone / Security Key
                  </button>
                )}
                <button id="reg-skip-passkey" className="btn-ghost" onClick={() => setStep(4)} disabled={busy}>
                  Skip: Face Recognition only
                </button>
              </div>
            </div>
          )}

          {step === 4 && registered && (
            <div className="space-y-6">
              {/* Official Digital Voter Credential Card (IEBC Republic of Kenya Style) */}
              <div className="relative overflow-hidden rounded-2xl border border-line bg-linear-to-b from-surface to-paper p-6 shadow-sm">
                {/* Kenyan Flag Banner */}
                <div className="flag-bar -mx-6 -mt-6 mb-5 h-2 w-[calc(100%+3rem)]" aria-hidden />

                <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
                  {/* Photo & Holographic Seal */}
                  <div className="flex flex-col items-center sm:items-start">
                    <div className="relative size-36 overflow-hidden rounded-2xl border-2 border-forest bg-paper-2 shadow-sm ">
                      {registered.photoDataUrl ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={registered.photoDataUrl}
                          alt="Official Voter Photo"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="grid h-full w-full place-items-center">
                          <IdCard className="size-16 text-ink-faint" />
                        </div>
                      )}
                      <span className="absolute bottom-1 right-1 rounded-md bg-paper px-1.5 py-0.5 text-[9px] font-bold text-forest border border-forest/40">
                        VERIFIED
                      </span>
                    </div>
                    <span className="mt-2 text-[10px] font-mono tracking-widest text-ink-soft uppercase">
                      ID: {registered.idNumber}
                    </span>
                  </div>

                  {/* Voter Information Grid */}
                  <div className="flex-1 space-y-3">
                    <div className="border-b border-line pb-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold tracking-widest text-forest uppercase">
                          REPUBLIC OF KENYA • IEBC
                        </span>
                        <span className="inline-flex items-center gap-1 rounded-full bg-forest-soft px-2 py-0.5 text-[10px] font-semibold text-forest border border-forest/30">
                          <CheckCircle2 className="size-3" /> ACTIVE VOTER
                        </span>
                      </div>
                      <h3 className="mt-1 text-xl font-bold tracking-tight text-ink uppercase">{registered.fullName}</h3>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-xl border border-line bg-paper p-2.5">
                        <span className="text-[10px] text-ink-soft">County</span>
                        <p className="font-semibold text-ink">{county?.name ?? form.countyCode}</p>
                      </div>
                      <div className="rounded-xl border border-line bg-paper p-2.5">
                        <span className="text-[10px] text-ink-soft">Constituency</span>
                        <p className="font-semibold text-ink">{constituency?.name ?? form.constituencyCode}</p>
                      </div>
                      <div className="rounded-xl border border-line bg-paper p-2.5">
                        <span className="text-[10px] text-ink-soft">Ward</span>
                        <p className="font-semibold text-ink">{ward?.name ?? form.wardCode}</p>
                      </div>
                      <div className="rounded-xl border border-line bg-paper p-2.5">
                        <span className="text-[10px] text-ink-soft">Phone</span>
                        <p className="font-mono text-ink">{registered.phone ?? form.phone}</p>
                      </div>
                    </div>

                    {/* Biometric Status Row */}
                    <div className="flex items-center justify-between rounded-xl border border-forest/30 bg-forest-soft px-3 py-2 text-xs">
                      <span className="inline-flex items-center gap-1.5 text-forest font-medium">
                        <ShieldCheck className="size-4 text-forest" /> Face Biometrics: 128-d Enrolled
                      </span>
                      <span className="text-ink-soft text-[11px]">
                        Fingerprint: {passkeyAdded ? "Linked ✓" : "None"}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Footer security banner */}
                <div className="mt-5 flex items-center justify-between border-t border-line pt-3 text-[11px] text-ink-soft">
                  <span className="inline-flex items-center gap-1 font-mono">
                    <QrCode className="size-3.5 text-ink-soft" /> REG-REF: KE-2027-{registered.idNumber}
                  </span>
                  <span className="text-[10px] text-ink-soft">Location-Independent Voting Authorized</span>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-col justify-center gap-3 sm:flex-row">
                <button
                  type="button"
                  id="reg-print-card"
                  onClick={() => window.print()}
                  className="btn-ghost"
                >
                  <Printer className="size-4" aria-hidden /> Print / Save Voter Card
                </button>
                <button
                  type="button"
                  id="reg-another"
                  className="btn-primary"
                  onClick={reset}
                >
                  <UserPlus className="size-5" aria-hidden /> Register Another Citizen
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
    <p role="alert" className="flex items-start gap-2 rounded-xl border border-clay/30 bg-clay-soft p-3 text-left text-sm text-clay">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-clay" aria-hidden /> {msg}
    </p>
  );
}
