"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Loader2, ShieldCheck } from "lucide-react";
import { PageTitle } from "@/components/Brand";
import { ReceiptVerifier } from "@/components/ReceiptVerifier";
import { useI18n } from "@/lib/i18n/I18n";

function VerifyContent() {
  const code = useSearchParams().get("code") ?? "";
  return <ReceiptVerifier initialCode={code} />;
}

export default function VerifyVotePage() {
  const { t } = useI18n();
  return (
    <main className="mx-auto min-h-dvh max-w-3xl px-4 py-12">
      <PageTitle eyebrow={t("verify.eyebrow")} title={t("verify.title")} />
      <section className="glass space-y-7 p-6 sm:p-9">
        <p className="flex items-start gap-3 text-[15px] leading-relaxed text-ink-soft">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-forest" />
          {t("verify.lead")}
        </p>
        <Suspense fallback={<Loader2 className="mx-auto size-8 animate-spin text-forest" />}>
          <VerifyContent />
        </Suspense>
        <div className="flex flex-wrap justify-between gap-3 border-t border-line pt-5 text-sm">
          <Link href="/results" className="flex items-center gap-1.5 font-semibold text-forest hover:underline">
            {t("verify.resultsLink")} <ArrowRight className="size-4" />
          </Link>
          <Link href="/login" className="text-ink-soft hover:text-ink">
            {t("verify.voteLink")}
          </Link>
        </div>
      </section>
    </main>
  );
}
