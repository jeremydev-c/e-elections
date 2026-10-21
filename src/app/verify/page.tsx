"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Loader2, ShieldCheck } from "lucide-react";
import { PageTitle } from "@/components/Brand";
import { ReceiptVerifier } from "@/components/ReceiptVerifier";

function VerifyContent() {
  const code = useSearchParams().get("code") ?? "";
  return <ReceiptVerifier initialCode={code} />;
}

export default function VerifyVotePage() {
  return (
    <main className="mx-auto min-h-dvh max-w-3xl px-4 py-8">
      <PageTitle eyebrow="Public Vote Ledger Verification" title="Verify My Vote Receipt" />
      <section className="glass space-y-6 p-6 sm:p-8">
        <p className="flex items-start gap-2 text-sm text-ink-soft">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-forest" />
          Enter the anonymous receipt code you received after voting. We recompute its SHA-256 seal and check both
          neighbouring links in the chain.
        </p>
        <Suspense fallback={<Loader2 className="mx-auto size-8 animate-spin text-forest" />}>
          <VerifyContent />
        </Suspense>
        <div className="flex justify-between border-t border-line pt-4 text-xs">
          <Link href="/results" className="flex items-center gap-1 text-forest hover:underline">
            Live results &amp; full chain audit <ArrowRight className="size-3.5" />
          </Link>
          <Link href="/login" className="text-ink-soft hover:text-ink">
            Go to voting
          </Link>
        </div>
      </section>
    </main>
  );
}
