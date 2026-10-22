"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight, Menu, X } from "lucide-react";
import { Brand } from "@/components/Brand";
import { useI18n, type Lang } from "@/lib/i18n/I18n";

const LINKS = [
  { href: "/results", key: "nav.results", match: ["/results"] },
  { href: "/verify", key: "nav.verify", match: ["/verify"] },
  // Voter registration is for officials only: reached from the Officials page after signing in.
  { href: "/setup", key: "nav.officials", match: ["/setup", "/register"] },
];

/** EN | SW: the language of the whole site, remembered for a year. */
export function LanguageSwitch({ className = "inline-flex" }: { className?: string }) {
  const { lang, setLang, t } = useI18n();
  const options: { value: Lang; label: string; name: string }[] = [
    { value: "en", label: "EN", name: "English" },
    { value: "sw", label: "SW", name: "Kiswahili" },
  ];
  return (
    <div role="radiogroup" aria-label={t("common.language")} className={`rounded-full border border-line-strong p-0.5 ${className}`}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={lang === o.value}
          title={o.name}
          onClick={() => setLang(o.value)}
          className={`rounded-full px-2.5 py-1 font-mono text-[11px] font-medium tracking-wider transition ${
            lang === o.value ? "bg-ink text-paper" : "text-ink-soft hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SiteNav() {
  const pathname = usePathname() ?? "/";
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const voting = pathname.startsWith("/login") || pathname.startsWith("/ballot");

  // Close the phone menu when the page changes.
  useEffect(() => {
    const id = setTimeout(() => setOpen(false), 0);
    return () => clearTimeout(id);
  }, [pathname]);

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-paper/85 backdrop-blur-md print:hidden">
      <div className="flag-bar h-[3px] w-full" aria-hidden />
      <nav className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3" aria-label={t("nav.main")}>
        <Brand subtitle={t("nav.republic")} />
        <div className="flex items-center gap-2">
          <ul className="hidden items-center gap-1 md:flex">
            {LINKS.map(({ href, key, match }) => {
              const active = match.some((m) => pathname.startsWith(m));
              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={`rounded-full px-3 py-1.5 text-sm transition ${
                      active ? "bg-ink/[0.06] font-semibold text-ink" : "text-ink-soft hover:text-ink"
                    }`}
                  >
                    {t(key)}
                  </Link>
                </li>
              );
            })}
          </ul>
          <LanguageSwitch className="hidden sm:inline-flex" />
          <Link
            href="/login"
            className={`btn-primary whitespace-nowrap px-4 py-2 text-sm ${voting ? "pointer-events-none opacity-50" : ""}`}
            aria-current={voting ? "page" : undefined}
          >
            {t("nav.vote")} <ArrowRight className="size-4" aria-hidden />
          </Link>
          <button
            className="grid size-9 place-items-center rounded-full border border-line-strong text-ink md:hidden"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label={open ? t("nav.close") : t("nav.menu")}
          >
            {open ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
        </div>
      </nav>
      {open && (
        <div id="mobile-menu" className="border-t border-line bg-paper px-4 pb-5 pt-2 md:hidden">
          <ul className="divide-y divide-line">
            {LINKS.map(({ href, key, match }) => (
              <li key={href}>
                <Link
                  href={href}
                  className={`flex items-center justify-between py-3.5 text-base ${
                    match.some((m) => pathname.startsWith(m)) ? "font-semibold text-ink" : "text-ink-soft"
                  }`}
                >
                  {t(key)} <ArrowRight className="size-4" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center justify-between">
            <span className="eyebrow">{t("common.language")}</span>
            <LanguageSwitch />
          </div>
        </div>
      )}
    </header>
  );
}
