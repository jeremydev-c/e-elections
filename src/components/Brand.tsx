import Link from "next/link";

/** Seal-style emblem: a ballot tick inside a shield, banded in the flag's colours. */
export function Emblem({ className = "size-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden>
      <path d="M20 2.5 35 8v11.2c0 9-6.3 15.6-15 18.3C11.3 34.8 5 28.2 5 19.2V8z" fill="#1f5a39" />
      <path d="M20 5.4 32.4 10v9.2c0 7.6-5.2 13.2-12.4 15.6-7.2-2.4-12.4-8-12.4-15.6V10z" fill="none" stroke="#fffcf6" strokeOpacity=".35" />
      <rect x="5" y="8" width="30" height="2.2" fill="#1f2219" />
      <rect x="5" y="10.2" width="30" height="1.1" fill="#fffcf6" />
      <rect x="5" y="11.3" width="30" height="1.8" fill="#a83e2a" />
      <path d="m13.5 21 4.4 4.4 8.6-9" fill="none" stroke="#fffcf6" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Brand({ subtitle }: { subtitle?: string }) {
  return (
    <Link href="/" className="group inline-flex shrink-0 items-center gap-2.5" id="brand-home-link">
      <Emblem className="size-9 transition-transform duration-300 group-hover:-rotate-6" />
      <span className="leading-none">
        <span className="block font-display text-[1.15rem] font-semibold tracking-tight text-ink">E-Elections</span>
        <span className="mt-1 hidden text-[10px] font-bold uppercase tracking-[0.22em] text-ink-faint min-[400px]:block">
          {subtitle ?? "Republic of Kenya"}
        </span>
      </span>
    </Link>
  );
}

/** Page heading used under the global navigation bar. */
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
    <div className="mb-8 flex flex-col gap-4 border-b border-line pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="animate-fade-up">
        <p className="eyebrow flex items-center gap-2">
          <span className="h-px w-6 bg-forest" aria-hidden />
          {eyebrow}
        </p>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-ink sm:text-[2.6rem] sm:leading-[1.1]">
          {title}
        </h1>
        {lead && <p className="mt-2 max-w-2xl text-[15px] text-ink-soft">{lead}</p>}
      </div>
      {children}
    </div>
  );
}
