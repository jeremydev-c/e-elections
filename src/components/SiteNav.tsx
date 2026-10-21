"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { Brand } from "@/components/Brand";

const LINKS = [
  { href: "/results", label: "Live results", match: ["/results"] },
  { href: "/verify", label: "Verify receipt", match: ["/verify"] },
  { href: "/register", label: "Registration", match: ["/register"] },
  { href: "/setup", label: "Setup", match: ["/setup"] },
];

export function SiteNav() {
  const pathname = usePathname() ?? "/";
  const voting = pathname.startsWith("/login") || pathname.startsWith("/ballot");

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-paper/90 backdrop-blur-md print:hidden">
      <div className="flag-bar h-[5px] w-full" aria-hidden />
      <nav className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3" aria-label="Main">
        <Brand />
        <div className="flex items-center gap-1 sm:gap-2">
          <ul className="hidden items-center gap-1 md:flex">
            {LINKS.map(({ href, label, match }) => {
              const active = match.some((m) => pathname.startsWith(m));
              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={`relative rounded-md px-3 py-2 text-sm font-medium transition ${
                      active ? "text-forest" : "text-ink-soft hover:text-ink"
                    }`}
                  >
                    {label}
                    {active && <span className="absolute inset-x-3 -bottom-[13px] h-0.5 rounded-full bg-forest" aria-hidden />}
                  </Link>
                </li>
              );
            })}
          </ul>
          <Link
            href="/results"
            className={`rounded-md px-3 py-2 text-sm font-medium md:hidden ${pathname.startsWith("/results") ? "text-forest" : "text-ink-soft"}`}
          >
            Results
          </Link>
          <Link
            href="/login"
            className={`btn-primary whitespace-nowrap px-3.5 py-2 text-sm sm:px-4 ${voting ? "pointer-events-none opacity-60" : ""}`}
            aria-current={voting ? "page" : undefined}
          >
            Vote now <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
      </nav>
    </header>
  );
}
