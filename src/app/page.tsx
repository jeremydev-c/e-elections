"use client";

import Link from "next/link";
import { ArrowRight, ArrowUpRight, EyeOff, IdCard, Link2, MapPin, ReceiptText, ScanFace, Settings2, ShieldCheck, Vote } from "lucide-react";
import { useI18n } from "@/lib/i18n/I18n";

const STEP_ICONS = [IdCard, ScanFace, Vote, ReceiptText];
const PILLAR_ICONS = [ScanFace, MapPin, Link2, EyeOff];
const CHAIN = [
  { seq: 1041, hash: "9f2c…a71e" },
  { seq: 1042, hash: "4be0…13cd" },
  { seq: 1043, hash: "c7d5…08f4" },
];

type Item = { title: string; text: string };
type Stat = { n: string; label: string };

export default function Home() {
  const { t, list } = useI18n();

  return (
    <main className="overflow-x-clip">
      {/* ---------------- Hero ---------------- */}
      <section className="mx-auto grid max-w-6xl items-center gap-16 px-4 pb-20 pt-14 lg:grid-cols-[1.2fr_0.8fr] lg:pt-24">
        <div className="animate-fade-up">
          <p className="eyebrow flex items-center gap-2.5">
            <span className="size-1.5 rounded-full bg-clay" aria-hidden />
            {t("home.eyebrow")}
          </p>
          <h1 className="mt-6 font-display text-[3.3rem] leading-[0.98] text-ink sm:text-[4.6rem] lg:text-[5.6rem]">
            {t("home.titleA")} <em className="italic text-forest">{t("home.titleB")}</em>
          </h1>
          <p className="mt-7 max-w-xl text-lg leading-relaxed text-ink-soft">{t("home.lead")}</p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <Link href="/login" className="btn-primary px-7 py-4 text-base">
              {t("home.ctaVote")} <ArrowRight className="size-5" aria-hidden />
            </Link>
            <Link href="/results" className="btn-ghost px-7 py-4 text-base">
              {t("home.ctaResults")}
            </Link>
          </div>
          <dl className="mt-12 grid max-w-lg grid-cols-3 border-t border-line">
            {list<Stat>("home.stats").map(({ n, label }) => (
              <div key={label} className="min-w-0 pt-4">
                <dt className="sr-only">{label}</dt>
                <dd className="font-display text-4xl leading-none text-ink">{n}</dd>
                <dd className="mt-2 truncate font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-faint">{label}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* Receipt */}
        <div className="relative mx-auto w-full max-w-sm animate-fade-up [animation-delay:150ms]">
          <figure className="relative -rotate-[1.5deg] rounded-t-lg bg-surface shadow-[0_40px_80px_-40px_rgb(19_21_15/0.45),0_1px_3px_rgb(19_21_15/0.08)] transition-transform duration-700 hover:rotate-0">
            <div className="flag-bar h-1.5 rounded-t-lg" aria-hidden />
            <div className="space-y-6 px-7 pb-8 pt-6">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-faint">{t("home.receipt.label")}</p>
                  <p className="mt-1.5 font-display text-2xl text-ink">{t("home.receipt.republic")}</p>
                </div>
                <ShieldCheck className="size-7 text-forest" aria-hidden />
              </div>

              <div className="border-y border-dashed border-line-strong py-4 text-center">
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">{t("home.receipt.code")}</p>
                <p className="mt-1.5 font-mono text-lg font-medium tracking-[0.12em] text-ink">KE-2027-8F9A-K7QX</p>
              </div>

              <div>
                <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">{t("home.receipt.chain")}</p>
                <ol>
                  {CHAIN.map((b, i) => {
                    const last = i === CHAIN.length - 1;
                    return (
                      <li key={b.seq} className="relative flex items-center gap-3 pb-3 last:pb-0">
                        {!last && <span className="absolute left-[9px] top-5 h-full w-px bg-line-strong" aria-hidden />}
                        <span className={`relative size-[19px] shrink-0 rounded-full border-2 ${last ? "border-forest bg-forest" : "border-line-strong bg-surface"}`} />
                        <span className="flex flex-1 items-baseline justify-between font-mono text-xs">
                          <span className="text-ink-soft">{t("home.receipt.ballot", { n: b.seq })}</span>
                          <span className={last ? "font-medium text-forest" : "text-ink-faint"}>{b.hash}</span>
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </div>

              <p className="text-[13px] leading-relaxed text-ink-soft">{t("home.receipt.note")}</p>
            </div>
            <div className="perforated h-3 rotate-180" aria-hidden />
            <span
              className="absolute -right-4 top-[58%] rotate-[12deg] rounded border-[3px] border-clay/80 px-3 py-1 font-mono text-sm font-medium uppercase tracking-[0.2em] text-clay/90 mix-blend-multiply"
              aria-hidden
            >
              {t("home.receipt.sealed")}
            </span>
          </figure>
        </div>
      </section>

      {/* ---------------- How it works ---------------- */}
      <section className="border-t border-line">
        <div className="mx-auto max-w-6xl px-4 py-24">
          <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr] lg:items-end">
            <p className="eyebrow">{t("home.howEyebrow")}</p>
            <h2 className="font-display text-4xl leading-tight text-ink sm:text-5xl">{t("home.howTitle")}</h2>
          </div>
          <ol className="mt-16 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
            {list<Item>("home.steps").map(({ title, text }, i) => {
              const Icon = STEP_ICONS[i];
              return (
                <li key={title} className="group bg-paper p-7 transition-colors hover:bg-surface">
                  <div className="flex items-center justify-between">
                    <span className="font-display text-6xl leading-none text-line-strong transition-colors group-hover:text-forest">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <Icon className="size-5 text-ink-faint" aria-hidden />
                  </div>
                  <h3 className="mt-10 text-lg font-semibold text-ink">{title}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-ink-soft">{text}</p>
                </li>
              );
            })}
          </ol>
        </div>
      </section>

      {/* ---------------- Ledger band ---------------- */}
      <section className="bg-night text-paper">
        <div className="mx-auto grid max-w-6xl items-center gap-14 px-4 py-24 lg:grid-cols-[1fr_1fr]">
          <div>
            <p className="eyebrow text-paper/60">{t("home.ledgerEyebrow")}</p>
            <h2 className="mt-4 font-display text-4xl leading-[1.05] text-paper sm:text-[3.4rem]">
              {t("home.ledgerTitleA")} <em className="italic text-[#e8c167]">{t("home.ledgerTitleB")}</em>
            </h2>
            <p className="mt-6 max-w-lg text-[16px] leading-relaxed text-paper/70">{t("home.ledgerText")}</p>
            <Link href="/results#audit-heading" className="btn mt-9 bg-paper text-ink hover:bg-white">
              {t("home.ledgerCta")} <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
          <div aria-hidden>
            <div className="grid grid-cols-3 gap-3 font-mono text-[11px]">
              {["0000…genesis", "9f2c…a71e", "4be0…13cd"].map((prev, i) => (
                <div key={prev} className="relative rounded-xl border border-white/12 bg-white/[0.04] p-4">
                  <p className="text-paper/50">{t("home.receipt.ballot", { n: 1041 + i })}</p>
                  <p className="mt-4 text-paper/40">{t("home.ledgerPrev")}</p>
                  <p className="break-all text-paper/85">{prev}</p>
                  <p className="mt-3 text-paper/40">{t("home.ledgerSeal")}</p>
                  <p className="text-[#e8c167]">{["9f2c…a71e", "4be0…13cd", "c7d5…08f4"][i]}</p>
                  {i < 2 && <span className="absolute -right-3 top-1/2 h-px w-3 bg-[#e8c167]/60" />}
                </div>
              ))}
            </div>
            <p className="mt-4 text-center text-xs text-paper/50">{t("home.ledgerCaption")}</p>
          </div>
        </div>
      </section>

      {/* ---------------- Measured, not promised ---------------- */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-6xl px-4 py-20">
          <p className="eyebrow">{t("home.numbersEyebrow")}</p>
          <dl className="mt-10 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
            {list<Stat>("home.numbers").map(({ n, label }) => (
              <div key={label} className="border-l-2 border-forest pl-5">
                <dt className="font-display text-5xl leading-none text-ink">{n}</dt>
                <dd className="mt-3 text-[15px] leading-snug text-ink-soft">{label}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ---------------- Pillars ---------------- */}
      <section className="mx-auto max-w-6xl px-4 py-24">
        <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr] lg:items-end">
          <p className="eyebrow">{t("home.trustEyebrow")}</p>
          <h2 className="font-display text-4xl leading-tight text-ink sm:text-5xl">{t("home.trustTitle")}</h2>
        </div>
        <div className="mt-14 grid gap-x-12 gap-y-12 sm:grid-cols-2">
          {list<Item>("home.pillars").map(({ title, text }, i) => {
            const Icon = PILLAR_ICONS[i];
            return (
              <div key={title} className="flex gap-5 border-t border-line pt-7">
                <span className="grid size-11 shrink-0 place-items-center rounded-full bg-forest-soft text-forest">
                  <Icon className="size-5" aria-hidden />
                </span>
                <div>
                  <h3 className="font-display text-[1.75rem] leading-tight text-ink">{title}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-ink-soft">{text}</p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ---------------- Officials ---------------- */}
      <section className="mx-auto max-w-6xl px-4">
        <div className="flex flex-col gap-6 rounded-2xl border border-line bg-surface p-8 sm:flex-row sm:items-center sm:justify-between sm:p-10">
          <div>
            <p className="eyebrow">{t("home.officialsEyebrow")}</p>
            <h2 className="mt-2 font-display text-3xl text-ink">{t("home.officialsTitle")}</h2>
            <p className="mt-2 max-w-lg text-[15px] text-ink-soft">{t("home.officialsText")}</p>
          </div>
          <Link href="/setup" className="btn-ghost shrink-0">
            <Settings2 className="size-4" aria-hidden /> {t("home.officialsCta")} <ArrowUpRight className="size-4" aria-hidden />
          </Link>
        </div>
      </section>
    </main>
  );
}
