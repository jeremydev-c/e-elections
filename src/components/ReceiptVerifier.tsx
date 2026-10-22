"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Link2, Loader2, Search, ShieldAlert, ShieldCheck } from "lucide-react";
import { useI18n } from "@/lib/i18n/I18n";

type Verification = {
  found: boolean;
  verified?: boolean;
  error?: string;
  block?: {
    seq: number;
    receiptCode: string;
    county: string | null;
    timestamp: string;
    previousHash: string;
    currentHash: string;
    recomputedHash: string;
    seatsCount: number;
  };
  proof?: { hashIntegrity: boolean; serverSealValid: boolean; parentLinkIntact: boolean; childLinkIntact: boolean };
};

/** "Verify my vote receipt": looks a receipt up in the ledger and shows its SHA-256 proof. */
export function ReceiptVerifier({ initialCode = "", compact = false }: { initialCode?: string; compact?: boolean }) {
  const { t, serverText, locale } = useI18n();
  const [code, setCode] = useState(initialCode);
  const [result, setResult] = useState<Verification | null>(null);
  const [loading, setLoading] = useState(false);
  const autoRan = useRef(false);

  const verify = useCallback(async (raw: string) => {
    const clean = raw.trim().toUpperCase();
    if (!clean) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(`/api/ledger/verify?receiptCode=${encodeURIComponent(clean)}`);
      setResult(await res.json());
    } catch {
      setResult({ found: false, error: "" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialCode && !autoRan.current) {
      autoRan.current = true;
      const id = setTimeout(() => verify(initialCode), 0);
      return () => clearTimeout(id);
    }
  }, [initialCode, verify]);

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          verify(code);
        }}
        className={`flex flex-col gap-2 ${compact ? "" : "sm:flex-row"}`}
      >
        <label htmlFor="receipt-code" className="sr-only">
          {t("receipt.label")}
        </label>
        <input
          id="receipt-code"
          className="field flex-1 font-mono uppercase tracking-wider"
          placeholder="KE-2027-XXXX-XXXX"
          autoComplete="off"
          spellCheck={false}
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button className="btn-primary shrink-0" disabled={loading || !code.trim()}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />} {t("receipt.verify")}
        </button>
      </form>

      {result && !result.found && (
        <p role="alert" className="flex items-start gap-2 rounded-xl border border-clay/40 bg-clay-soft p-3.5 text-sm text-clay">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" /> {result.error ? serverText(result.error) : t("common.networkError")}
        </p>
      )}

      {result?.found && result.block && result.proof && (
        <div className={`space-y-4 rounded-2xl border p-5 animate-fade-up ${result.verified ? "border-forest/30 bg-forest-soft" : "border-clay/50 bg-clay-soft"}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className={`flex items-center gap-2 font-semibold ${result.verified ? "text-forest" : "text-clay"}`}>
              {result.verified ? <ShieldCheck className="size-5" /> : <ShieldAlert className="size-5" />}
              {result.verified ? t("receipt.ok") : t("receipt.bad")}
            </p>
            <span className="rounded-full bg-surface px-2.5 py-0.5 font-mono text-xs text-ink">{t("receipt.block", { n: result.block.seq })}</span>
          </div>
          <div className={`grid gap-2 text-xs ${compact ? "" : "sm:grid-cols-2"}`}>
            <Check ok={result.proof.hashIntegrity} label={t("receipt.hash")} />
            <Check ok={result.proof.serverSealValid} label={t("receipt.seal")} />
            <Check ok={result.proof.parentLinkIntact} label={t("receipt.parent")} />
            <Check ok={result.proof.childLinkIntact} label={t("receipt.child")} />
          </div>
          {!compact && (
            <dl className="space-y-2.5 rounded-xl bg-surface p-4 font-mono text-[11px]">
              <Row k={t("receipt.rowReceipt")} v={result.block.receiptCode} />
              <Row k={t("receipt.rowRecorded")} v={`${new Date(result.block.timestamp).toLocaleString(locale)} · ${result.block.county ?? "—"}`} />
              <Row k={t("receipt.rowStored")} v={result.block.currentHash} accent />
              <Row k={t("receipt.rowRecomputed")} v={result.block.recomputedHash} accent={result.proof.hashIntegrity} />
              <Row k={t("receipt.rowPrevious")} v={result.block.previousHash} />
            </dl>
          )}
          <p className="flex items-start gap-2 text-xs leading-relaxed text-ink-soft">
            <Link2 className="mt-0.5 size-3.5 shrink-0" /> {t("receipt.privacy")}
          </p>
        </div>
      )}
    </div>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 ${ok ? "bg-surface text-forest" : "bg-surface text-clay"}`}>
      {ok ? <CheckCircle2 className="size-3.5" /> : <ShieldAlert className="size-3.5" />} {label}
    </span>
  );
}

function Row({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[130px_1fr] sm:gap-3">
      <dt className="text-ink-faint">{k}</dt>
      <dd className={`break-all ${accent ? "text-forest" : "text-ink-soft"}`}>{v}</dd>
    </div>
  );
}
