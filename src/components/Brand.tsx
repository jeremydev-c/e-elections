import Link from "next/link";

/** Seal-style emblem: a ballot tick inside a shield, banded in the flag's colours. */
export function Emblem({ className = "size-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden>
      <path d="M20 2.5 35 8v11.2c0 9-6.3 15.6-15 18.3C11.3 34.8 5 28.2 5 19.2V8z" fill="#0b5d3b" />
      <path d="M20 5.4 32.4 10v9.2c0 7.6-5.2 13.2-12.4 15.6-7.2-2.4-12.4-8-12.4-15.6V10z" fill="none" stroke="#fbfaf6" strokeOpacity=".35" />
      <rect x="5" y="8" width="30" height="2.2" fill="#13150f" />
      <rect x="5" y="10.2" width="30" height="1.1" fill="#fbfaf6" />
      <rect x="5" y="11.3" width="30" height="1.8" fill="#b4261c" />
      <path d="m13.5 21 4.4 4.4 8.6-9" fill="none" stroke="#fbfaf6" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Brand({ subtitle }: { subtitle?: string }) {
  return (
    <Link href="/" className="group inline-flex shrink-0 items-center gap-2.5" id="brand-home-link">
      <Emblem className="size-9 transition-transform duration-300 group-hover:-rotate-6" />
      <span className="leading-none">
        <span className="block font-display text-[1.45rem] leading-none text-ink">E-Elections</span>
        <span className="mt-1 hidden font-mono text-[9.5px] uppercase tracking-[0.2em] text-ink-faint min-[400px]:block">
          {subtitle ?? "Republic of Kenya"}
        </span>
      </span>
    </Link>
  );
}

/** Page heading used under the global navigation bar: a mono section mark, a large serif title. */
export function PageTitle({
  eyebrow,
  title,
  lead,
  children,
}: {
  eyebrow: string;
  title: string;
  lead?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-10 flex flex-col gap-5 border-b border-line pb-8 sm:flex-row sm:items-end sm:justify-between">
      <div className="animate-fade-up">
        <p className="eyebrow flex items-center gap-2.5">
          <span className="size-1.5 rounded-full bg-forest" aria-hidden />
          {eyebrow}
        </p>
        <h1 className="mt-3 font-display text-[2.6rem] leading-[1.02] text-ink sm:text-[3.6rem]">{title}</h1>
        {lead && <p className="mt-3 max-w-2xl text-[16px] leading-relaxed text-ink-soft">{lead}</p>}
      </div>
      {children}
    </div>
  );
}
