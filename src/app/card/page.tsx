"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CircleAlert, CircleCheck, CircleX, Loader2, ShieldCheck } from "lucide-react";
import { PageTitle } from "@/components/Brand";
import { CardPattern } from "@/components/VoterCard";
import { useI18n } from "@/lib/i18n/I18n";

type Result =
  | { status: "valid" | "replaced" | "unknown"; cardNumber?: string; name?: string; county?: string; constituency?: string; ward?: string; issuedAt?: string }
  | { status: "forged" | "missing" }
  | { status: "error"; error: string };

function CardCheck() {
  const { t, serverText, locale } = useI18n();
  const token = useSearchParams().get("c") ?? "";
  const [result, setResult] = useState<Result | null>(token ? null : { status: "missing" });

  useEffect(() => {
    if (!token) return;
    let alive = true;
    fetch(`/api/card/verify?c=${encodeURIComponent(token)}`)
      .then(async (r) => {
        const d = await r.json();
        if (!alive) return;
        setResult(r.ok ? d : { status: "error", error: serverText(d.error ?? "") });
      })
      .catch(() => alive && setResult({ status: "error", error: t("card.failed") }));
    return () => {
      alive = false;
    };
  }, [token, serverText, t]);

  if (!result) {
    return (
      <p className="flex items-center justify-center gap-2 py-12 text-ink-soft">
        <Loader2 className="size-5 animate-spin" /> {t("card.checking")}
      </p>
    );
  }

  const tone = {
    valid: { box: "border-forest/40 bg-forest-soft text-forest", Icon: CircleCheck, title: t("card.valid"), text: t("card.validText") },
    replaced: { box: "border-ochre/50 bg-ochre-soft text-ochre-deep", Icon: CircleAlert, title: t("card.replaced"), text: t("card.replacedText") },
    unknown: { box: "border-ochre/50 bg-ochre-soft text-ochre-deep", Icon: CircleAlert, title: t("card.unknown"), text: t("card.unknownText") },
    forged: { box: "border-clay/40 bg-clay-soft text-clay", Icon: CircleX, title: t("card.forged"), text: t("card.forgedText") },
    missing: { box: "border-line bg-paper-2 text-ink-soft", Icon: CircleAlert, title: t("card.checkTitle"), text: t("card.missing") },
    error: { box: "border-clay/40 bg-clay-soft text-clay", Icon: CircleX, title: t("card.failed"), text: result.status === "error" ? result.error : "" },
  }[result.status];

  const details = "cardNumber" in result && result.cardNumber ? result : null;

  return (
    <div className="space-y-7">
      <div role="status" className={`flex items-start gap-4 rounded-2xl border p-5 ${tone.box}`}>
        <tone.Icon className="mt-0.5 size-8 shrink-0" aria-hidden />
        <div>
          <p className="font-display text-3xl leading-tight">{tone.title}</p>
          <p className="mt-1 text-sm">{tone.text}</p>
        </div>
      </div>

      {details && (
        <>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm sm:grid-cols-3">
            {[
              [t("card.name"), details.name],
              [t("card.cardNo"), details.cardNumber],
              [t("common.county"), details.county],
              [t("common.constituency"), details.constituency],
              [t("common.ward"), details.ward],
              ...(details.issuedAt
                ? [[t("card.issued"), new Date(details.issuedAt).toLocaleDateString(locale, { dateStyle: "medium" })]]
                : []),
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">{k}</dt>
                <dd className={`mt-0.5 font-semibold text-ink ${k === t("card.cardNo") ? "font-mono" : ""}`}>{v}</dd>
              </div>
            ))}
          </dl>

          <div className="border-t border-line pt-6">
            <h2 className="font-display text-2xl text-ink">{t("card.patternTitle")}</h2>
            <p className="mt-1 text-sm text-ink-soft">{t("card.patternText")}</p>
            <CardPattern cardNumber={details.cardNumber!} className="mt-5 h-auto w-full max-w-md drop-shadow-md" />
          </div>
        </>
      )}

      <p className="flex items-start gap-2 border-t border-line pt-5 text-xs text-ink-faint">
        <ShieldCheck className="size-4 shrink-0 text-forest" aria-hidden /> {t("card.privacy")}
      </p>
    </div>
  );
}

export default function CardCheckPage() {
  const { t } = useI18n();
  return (
    <main className="mx-auto min-h-dvh max-w-3xl px-4 py-12">
      <PageTitle eyebrow={t("card.checkEyebrow")} title={t("card.checkTitle")} lead={t("card.checkLead")} />
      <section className="glass p-6 sm:p-9">
        <Suspense fallback={<Loader2 className="mx-auto size-8 animate-spin text-forest" />}>
          <CardCheck />
        </Suspense>
      </section>
    </main>
  );
}
