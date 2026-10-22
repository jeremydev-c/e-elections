"use client";

import Link from "next/link";
import { Emblem } from "@/components/Brand";
import { LanguageSwitch } from "@/components/SiteNav";
import { useI18n } from "@/lib/i18n/I18n";

export function SiteFooter() {
  const { t } = useI18n();
  const links: [string, string][] = [
    ["/login", t("footer.vote")],
    ["/results", t("footer.results")],
    ["/verify", t("footer.verify")],
    ["/setup", t("footer.officials")],
  ];
  return (
    <footer className="mt-24 bg-night text-paper print:hidden">
      <div className="flag-bar h-[3px]" aria-hidden />
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 md:grid-cols-[1.4fr_1fr]">
        <div>
          <div className="flex items-center gap-3">
            <Emblem className="size-10" />
            <span className="font-display text-3xl text-paper">E-Elections</span>
          </div>
          <p className="mt-5 max-w-sm font-display text-2xl italic leading-snug text-paper/85">{t("footer.tagline")}</p>
        </div>
        <div className="grid gap-8 sm:grid-cols-2">
          <ul className="space-y-2.5 text-sm">
            {links.map(([href, label]) => (
              <li key={href}>
                <Link href={href} className="text-paper/70 transition hover:text-paper">
                  {label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="space-y-3">
            <LanguageSwitch className="inline-flex border-white/25 [&_button[aria-checked=false]]:text-paper/70 [&_button[aria-checked=true]]:bg-paper [&_button[aria-checked=true]]:text-ink" />
            <a href="https://github.com/jeremydev-c/e-elections" className="block text-sm text-paper/70 transition hover:text-paper">
              {t("footer.source")} ↗
            </a>
          </div>
        </div>
      </div>
      <div className="border-t border-white/10">
        <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-5 font-mono text-[11px] text-paper/50 sm:flex-row sm:justify-between">
          <p>{t("footer.fair")}</p>
          <p>{t("footer.demo")}</p>
        </div>
      </div>
    </footer>
  );
}
