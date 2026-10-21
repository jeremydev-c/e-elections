import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  EyeOff,
  Fingerprint,
  IdCard,
  Link2,
  MapPin,
  ReceiptText,
  ScanFace,
  Settings2,
  ShieldCheck,
  Vote,
} from "lucide-react";

const STEPS = [
  { icon: IdCard, title: "Enter your National ID", text: "The register is checked first. An ID that has already voted is stopped at the door." },
  { icon: ScanFace, title: "Prove it is you", text: "Choose a live face scan or your phone's fingerprint sensor. No passwords to forget." },
  { icon: Vote, title: "Mark your six choices", text: "Your county, constituency and ward races load on their own, wherever you are." },
  { icon: ReceiptText, title: "Keep your receipt", text: "A sealed, anonymous code lets you confirm your ballot was counted, and nothing more." },
];

const PILLARS = [
  { icon: Fingerprint, title: "Biometric choice", text: "128-point face matching with a random liveness check (turn and blink on cue), or a WebAuthn fingerprint that never leaves the device." },
  { icon: MapPin, title: "Vote from anywhere", text: "Ballots are routed to the voter's registered region, so nobody travels back to their polling centre." },
  { icon: Link2, title: "Tamper-evident ledger", text: "Each ballot carries the SHA-256 fingerprint of the one before it. Alter a record and the chain breaks." },
  { icon: EyeOff, title: "Secret ballot by design", text: "The ledger stores no name and no ID number. A receipt proves your vote counted, not how you voted." },
];

const CHAIN = [
  { seq: 1041, hash: "9f2c…a71e" },
  { seq: 1042, hash: "4be0…13cd" },
  { seq: 1043, hash: "c7d5…08f4" },
];

export default function Home() {
  return (
    <main className="overflow-x-clip">
      {/* ---------------- Hero ---------------- */}
      <section className="mx-auto grid max-w-6xl items-center gap-14 px-4 pb-16 pt-12 lg:grid-cols-[1.15fr_0.85fr] lg:pt-20">
        <div className="animate-fade-up">
          <p className="eyebrow flex items-center gap-2">
            <span className="h-px w-8 bg-forest" aria-hidden />
            General Election 2027 · KSEF &amp; YSK demonstration
          </p>
          <h1 className="mt-5 font-display text-[2.7rem] font-semibold leading-[1.04] tracking-tight text-ink sm:text-6xl lg:text-[4.4rem]">
            Every Kenyan vote, <em className="font-normal italic text-forest">counted in the open.</em>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-soft">
            E-Elections verifies each voter by face or fingerprint, routes them to their own ballot from anywhere in the
            country, and seals every vote into a public ledger that cannot be quietly rewritten.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href="/login" className="btn-primary px-6 py-3.5 text-base">
              Cast your vote <ArrowRight className="size-5" aria-hidden />
            </Link>
            <Link href="/results" className="btn-ghost px-6 py-3.5 text-base">
              <BarChart3 className="size-5" aria-hidden /> Watch live results
            </Link>
          </div>
          <dl className="mt-10 grid max-w-lg grid-cols-3 divide-x divide-line border-y border-line py-4">
            {[
              ["47", "counties"],
              ["290", "constituencies"],
              ["1,450", "wards"],
            ].map(([n, label]) => (
              <div key={label} className="min-w-0 px-3 first:pl-0 sm:px-4">
                <dt className="sr-only">{label}</dt>
                <dd className="font-display text-2xl font-semibold text-ink sm:text-3xl">{n}</dd>
                <dd className="truncate text-[10px] uppercase tracking-wider text-ink-faint sm:text-xs">{label}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* Receipt illustration */}
        <div className="relative mx-auto w-full max-w-sm animate-fade-up [animation-delay:150ms] lg:max-w-none">
          <div className="absolute -inset-6 -z-10 rotate-3 rounded-[2rem] bg-paper-2" aria-hidden />
          <figure className="relative -rotate-2 rounded-t-xl bg-surface shadow-[0_30px_60px_-30px_rgb(31_34_25/0.45),0_2px_6px_rgb(31_34_25/0.06)] transition-transform duration-500 hover:rotate-0">
            <div className="flag-bar h-2 rounded-t-xl" aria-hidden />
            <div className="space-y-5 px-7 pb-8 pt-6">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-ink-faint">Official ballot receipt</p>
                  <p className="mt-1 font-display text-xl font-semibold text-ink">Republic of Kenya</p>
                </div>
                <ShieldCheck className="size-8 text-forest" aria-hidden />
              </div>

              <div className="rounded-lg border border-dashed border-line-strong bg-paper px-4 py-3 text-center">
                <p className="text-[10px] uppercase tracking-[0.2em] text-ink-faint">Receipt code</p>
                <p className="mt-1 font-mono text-lg font-semibold tracking-[0.12em] text-ink">KE-2027-8F9A-K7QX</p>
              </div>

              <div>
                <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-ink-faint">Hash chain</p>
                <ol className="space-y-0">
                  {CHAIN.map((b, i) => (
                    <li key={b.seq} className="relative flex items-center gap-3 pb-3 last:pb-0">
                      {i < CHAIN.length - 1 && <span className="absolute left-[11px] top-6 h-full w-px bg-line-strong" aria-hidden />}
                      <span
                        className={`relative grid size-6 shrink-0 place-items-center rounded-full border text-[9px] font-bold ${
                          i === CHAIN.length - 1 ? "border-forest bg-forest text-white" : "border-line-strong bg-surface text-ink-faint"
                        }`}
                      >
                        <Link2 className="size-3" aria-hidden />
                      </span>
                      <span className="flex flex-1 items-baseline justify-between font-mono text-xs">
                        <span className="text-ink-soft">Ballot #{b.seq}</span>
                        <span className={i === CHAIN.length - 1 ? "font-semibold text-forest" : "text-ink-faint"}>{b.hash}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>

              <p className="border-t border-line pt-4 text-xs leading-relaxed text-ink-soft">
                No name. No ID number. Only proof that this ballot is in the count, exactly as it was cast.
              </p>
            </div>
            <div className="perforated h-3 rotate-180" aria-hidden />
            <span
              className="absolute -right-3 top-28 rotate-[14deg] rounded-md border-[3px] border-clay/80 px-3 py-1 font-display text-lg font-bold uppercase tracking-widest text-clay/90 mix-blend-multiply"
              aria-hidden
            >
              Sealed
            </span>
          </figure>
        </div>
      </section>

      <div className="kikoi h-2.5 opacity-90" aria-hidden />

      {/* ---------------- How it works ---------------- */}
      <section className="mx-auto max-w-6xl px-4 py-20">
        <div className="max-w-2xl">
          <p className="eyebrow">How voting works</p>
          <h2 className="mt-3 font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            Four steps, about two minutes, from any device.
          </h2>
        </div>
        <ol className="mt-12 grid gap-10 sm:grid-cols-2 lg:grid-cols-4 lg:gap-8">
          {STEPS.map(({ icon: Icon, title, text }, i) => (
            <li key={title} className="relative">
              <div className="flex items-center gap-4">
                <span className="font-display text-5xl font-semibold leading-none text-line-strong">{String(i + 1).padStart(2, "0")}</span>
                <span className="grid size-11 place-items-center rounded-full bg-forest-soft text-forest">
                  <Icon className="size-5" aria-hidden />
                </span>
              </div>
              <h3 className="mt-5 text-lg font-semibold text-ink">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">{text}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* ---------------- Ledger band ---------------- */}
      <section className="bg-forest-deep text-paper">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-20 lg:grid-cols-2">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#c9dcc8]">Anti-tamper ledger</p>
            <h2 className="mt-3 font-display text-3xl font-semibold leading-tight tracking-tight text-paper sm:text-[2.6rem]">
              Change one vote and the whole chain <em className="italic text-[#e9c77e]">says so.</em>
            </h2>
            <p className="mt-5 max-w-lg leading-relaxed text-[#d6e2d4]">
              Every three seconds the results page recomputes the SHA-256 seal of every ballot. Editing, deleting or
              reordering even a single record breaks a link, and the public integrity badge turns red for everyone to see.
            </p>
            <Link
              href="/results#audit-heading"
              className="mt-8 inline-flex items-center gap-2 rounded-lg bg-paper px-5 py-3 font-semibold text-forest-deep transition hover:bg-white"
            >
              Run the tamper test yourself <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
          <div className="grid grid-cols-3 gap-3 font-mono text-[11px]" aria-hidden>
            {["prev 0000…genesis", "prev 9f2c…a71e", "prev 4be0…13cd"].map((prev, i) => (
              <div key={prev} className="rounded-xl border border-white/15 bg-white/[0.06] p-4">
                <p className="text-[#a9c3a8]">Ballot #{1041 + i}</p>
                <p className="mt-3 break-all text-[#e9efe6]">{prev}</p>
                <p className="mt-3 text-[#e9c77e]">seal {["9f2c…a71e", "4be0…13cd", "c7d5…08f4"][i]}</p>
              </div>
            ))}
            <p className="col-span-3 pt-2 text-center font-sans text-xs text-[#a9c3a8]">
              Each seal is written into the next ballot, so no record stands alone.
            </p>
          </div>
        </div>
      </section>

      {/* ---------------- Pillars ---------------- */}
      <section className="mx-auto max-w-6xl px-4 py-20">
        <div className="max-w-2xl">
          <p className="eyebrow">Built for trust</p>
          <h2 className="mt-3 font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            Security that a voter can understand.
          </h2>
        </div>
        <div className="mt-12 grid border-l border-t border-line sm:grid-cols-2 lg:grid-cols-4">
          {PILLARS.map(({ icon: Icon, title, text }) => (
            <div key={title} className="border-b border-r border-line p-7 transition-colors hover:bg-surface">
              <Icon className="size-6 text-forest" aria-hidden />
              <h3 className="mt-5 font-display text-xl font-semibold text-ink">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">{text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---------------- Officials ---------------- */}
      <section className="mx-auto max-w-6xl px-4">
        <div className="glass flex flex-col gap-6 p-7 sm:flex-row sm:items-center sm:justify-between sm:p-9">
          <div>
            <p className="eyebrow">For election officials</p>
            <h2 className="mt-2 font-display text-2xl font-semibold text-ink">Officials&apos; portal</h2>
            <p className="mt-1 max-w-lg text-sm text-ink-soft">
              Signed-in officials register voters and prepare the election. Voters never need this page.
            </p>
          </div>
          <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
            <Link href="/setup" className="btn-ghost">
              <Settings2 className="size-4" aria-hidden /> Officials sign in
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
