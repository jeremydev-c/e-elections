"use client";

import { useId, useMemo, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { guilloche } from "@/lib/guilloche";

/**
 * The printed voter card, front and back, in banknote style.
 *
 * Both faces are SVG on an 856 × 540 grid (0.1 mm units of an 85.6 × 54 mm ID card),
 * so they stay sharp on screen and print at exact card size. The text is always in
 * Kiswahili and English, like the national ID, whatever language the site is in.
 */

export type VoterCardData = {
  fullName: string;
  idNumber: string;
  county: string;
  constituency: string;
  ward: string;
  cardNumber: string;
  serial: number;
  issuedAt: string;
  qr: { size: number; path: string };
  photoDataUrl?: string;
};

const W = 856;
const H = 540;
const INK = "#13150f";
const SOFT = "#5d6157";
const PAPER = "#f6f3ea";
const SANS = "var(--font-sans)";
const MONO = "var(--font-mono)";
const SERIF = "var(--font-display)";

const noSubscribe = () => () => {};

const issued = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase();

function Lines({ cardNumber, face }: { cardNumber: string; face: "front" | "back" }) {
  const g = useMemo(() => guilloche(cardNumber, W, H, face), [cardNumber, face]);
  return (
    <g fill="none" strokeLinecap="round">
      {g.waves.map((d, i) => (
        <path key={i} d={d} stroke={g.tint} strokeOpacity={0.17} strokeWidth={0.8} />
      ))}
      {g.rosettes.map((r, i) => (
        <path key={i} d={r.d} stroke={r.color} strokeOpacity={i ? 0.5 : 0.62} strokeWidth={r.width} />
      ))}
    </g>
  );
}

/** Kenyan flag colours as a band: black, red and green with white edges. */
function FlagBand({ y }: { y: number }) {
  return (
    <g>
      <rect x={0} y={y} width={W} height={10} fill="#000" />
      <rect x={0} y={y + 10} width={W} height={3} fill="#fff" />
      <rect x={0} y={y + 13} width={W} height={12} fill="#b4261c" />
      <rect x={0} y={y + 25} width={W} height={3} fill="#fff" />
      <rect x={0} y={y + 28} width={W} height={10} fill="#0b5d3b" />
    </g>
  );
}

/** A border of tiny repeated text. It prints as a thin line and blurs when photocopied. */
function Microtext({ id, text }: { id: string; text: string }) {
  const inset = 16;
  const line = `${text} · `.repeat(40);
  return (
    <g>
      <path id={id} d={`M${inset} ${inset} H${W - inset} V${H - inset} H${inset} Z`} fill="none" />
      <text fontFamily={MONO} fontSize={6.4} fill={INK} fillOpacity={0.55} letterSpacing={0.4}>
        <textPath href={`#${id}`}>{line}</textPath>
      </text>
    </g>
  );
}

function Label({ x, y, sw, en }: { x: number; y: number; sw: string; en: string }) {
  return (
    <text x={x} y={y} fontFamily={MONO} fontSize={12.5} letterSpacing={1.4} fill={SOFT}>
      {sw.toUpperCase()} <tspan fillOpacity={0.6}>·</tspan> {en.toUpperCase()}
    </text>
  );
}

export function VoterCardFront({ data, className }: { data: VoterCardData; className?: string }) {
  const uid = useId().replace(/:/g, "");
  const nameSize = data.fullName.length > 26 ? 27 : data.fullName.length > 20 ? 31 : 36;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={className} role="img" aria-label={`Voter card front: ${data.fullName}, ${data.ward} ward`}>
      <defs>
        <clipPath id={`${uid}-card`}>
          <rect width={W} height={H} rx={34} />
        </clipPath>
        <clipPath id={`${uid}-photo`}>
          <rect x={40} y={130} width={196} height={244} rx={14} />
        </clipPath>
        <filter id={`${uid}-ghost`}>
          <feColorMatrix type="saturate" values="0" />
        </filter>
      </defs>
      <g clipPath={`url(#${uid}-card)`}>
        <rect width={W} height={H} fill={PAPER} />
        <Lines cardNumber={data.cardNumber} face="front" />
        <FlagBand y={0} />

        <text x={40} y={76} fontFamily={SANS} fontWeight={700} fontSize={19} letterSpacing={2.2} fill={INK}>
          JAMHURI YA KENYA · REPUBLIC OF KENYA
        </text>
        <text x={40} y={101} fontFamily={MONO} fontSize={13.5} letterSpacing={1.8} fill="#0b5d3b">
          KADI YA MPIGA KURA · VOTER CARD
        </text>
        <text x={W - 40} y={98} textAnchor="end" fontFamily={SERIF} fontSize={54} fill={INK}>
          2027
        </text>

        {/* Photo, with a frame so a pasted-over photo shows its edges */}
        <rect x={40} y={130} width={196} height={244} rx={14} fill="#e4e0d4" />
        {data.photoDataUrl ? (
          <image href={data.photoDataUrl} x={40} y={130} width={196} height={244} preserveAspectRatio="xMidYMid slice" clipPath={`url(#${uid}-photo)`} />
        ) : (
          <g fill={SOFT} fillOpacity={0.35}>
            <circle cx={138} cy={220} r={44} />
            <rect x={78} y={276} width={120} height={80} rx={40} />
          </g>
        )}
        <rect x={40} y={130} width={196} height={244} rx={14} fill="none" stroke={INK} strokeOpacity={0.5} strokeWidth={1.5} />

        <Label x={276} y={152} sw="Jina" en="Name" />
        <text x={276} y={190} fontFamily={SANS} fontWeight={700} fontSize={nameSize} fill={INK}>
          {data.fullName.toUpperCase()}
        </text>

        <Label x={276} y={232} sw="Kitambulisho" en="ID No." />
        <text x={276} y={262} fontFamily={MONO} fontSize={25} letterSpacing={3} fill={INK}>
          {data.idNumber}
        </text>

        <Label x={276} y={302} sw="Kaunti" en="County" />
        <text x={276} y={330} fontFamily={SANS} fontWeight={600} fontSize={22} fill={INK}>
          {data.county}
        </text>
        <Label x={530} y={302} sw="Wadi" en="Ward" />
        <text x={530} y={330} fontFamily={SANS} fontWeight={600} fontSize={22} fill={INK}>
          {data.ward}
        </text>

        <Label x={276} y={370} sw="Eneo bunge" en="Constituency" />
        <text x={276} y={398} fontFamily={SANS} fontWeight={600} fontSize={22} fill={INK}>
          {data.constituency}
        </text>

        {/* Ghost photo: a small faded copy that a swapped main photo won't match */}
        {data.photoDataUrl && (
          <image
            href={data.photoDataUrl}
            x={704}
            y={300}
            width={112}
            height={140}
            preserveAspectRatio="xMidYMid slice"
            opacity={0.22}
            filter={`url(#${uid}-ghost)`}
          />
        )}

        <Label x={40} y={438} sw="Nambari ya kadi" en="Card No." />
        <text x={40} y={478} fontFamily={MONO} fontWeight={700} fontSize={33} letterSpacing={3.5} fill={INK}>
          {data.cardNumber}
        </text>
        <text x={W - 40} y={478} textAnchor="end" fontFamily={MONO} fontSize={13} letterSpacing={1.4} fill={SOFT}>
          IMETOLEWA · ISSUED {issued(data.issuedAt)}
        </text>

        <Microtext id={`${uid}-micro`} text={`${data.fullName.toUpperCase()} · ${data.cardNumber} · ${data.ward.toUpperCase()}`} />
      </g>
      <rect x={0.75} y={0.75} width={W - 1.5} height={H - 1.5} rx={34} fill="none" stroke={INK} strokeOpacity={0.25} strokeWidth={1.5} />
    </svg>
  );
}

export function VoterCardBack({ data, className }: { data: VoterCardData; className?: string }) {
  const uid = useId().replace(/:/g, "");
  const qrBox = 252;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={className} role="img" aria-label={`Voter card back: QR code for card ${data.cardNumber}`}>
      <defs>
        <clipPath id={`${uid}-card`}>
          <rect width={W} height={H} rx={34} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${uid}-card)`}>
        <rect width={W} height={H} fill={PAPER} />
        <Lines cardNumber={data.cardNumber} face="back" />

        {/* QR code on a white pad so phones can read it through the pattern */}
        <rect x={40} y={52} width={qrBox + 36} height={qrBox + 36} rx={18} fill="#fff" stroke={INK} strokeOpacity={0.2} />
        {data.qr.size > 0 && (
          <svg x={58} y={70} width={qrBox} height={qrBox} viewBox={`0 0 ${data.qr.size} ${data.qr.size}`} shapeRendering="crispEdges">
            <path d={data.qr.path} stroke={INK} fill="none" />
          </svg>
        )}
        <text x={40 + (qrBox + 36) / 2} y={372} textAnchor="middle" fontFamily={MONO} fontSize={12} letterSpacing={1.4} fill={SOFT}>
          {data.cardNumber}
        </text>

        <text x={370} y={84} fontFamily={SANS} fontWeight={700} fontSize={24} fill={INK}>
          Changanua kuthibitisha
        </text>
        <text x={370} y={114} fontFamily={SERIF} fontSize={26} fill="#0b5d3b">
          Scan to check this card is genuine
        </text>
        <foreignObject x={370} y={130} width={W - 410} height={180}>
          <div style={{ fontFamily: SANS, fontSize: 14.5, lineHeight: 1.45, color: INK }}>
            <p style={{ margin: 0 }}>
              Use any phone camera. A genuine card opens a green page showing the same initials, ward and pattern as
              this card.
            </p>
            <p style={{ margin: "8px 0 0", color: SOFT }}>
              Kadi halali hufungua ukurasa wa kijani wenye herufi za jina, wadi na mchoro sawa na wa kadi hii.
            </p>
            <p style={{ margin: "12px 0 0" }}>
              <b>Lost it?</b> An election official can reissue it, and the old card stops working.{" "}
              <span style={{ color: SOFT }}>Ikipotea, afisa wa uchaguzi atakupa nyingine.</span>
            </p>
          </div>
        </foreignObject>

        {/* Signature strip */}
        <rect x={370} y={330} width={446} height={58} rx={8} fill="#fff" fillOpacity={0.85} stroke={INK} strokeOpacity={0.35} />
        <text x={382} y={402} fontFamily={MONO} fontSize={11.5} letterSpacing={1.3} fill={SOFT}>
          SAHIHI YA MPIGA KURA · VOTER&apos;S SIGNATURE
        </text>

        <text x={40} y={430} fontFamily={MONO} fontSize={12.5} letterSpacing={1.4} fill={SOFT}>
          TOLEO · ISSUE {data.serial} · E-ELECTIONS · UCHAGUZI MKUU 2027
        </text>
        <FlagBand y={H - 82} />
        <rect x={0} y={H - 44} width={W} height={44} fill={INK} />
        <text x={W / 2} y={H - 17} textAnchor="middle" fontFamily={MONO} fontSize={12} letterSpacing={2} fill={PAPER} fillOpacity={0.8}>
          KILA KURA YA MKENYA, INAHESABIWA HADHARANI · EVERY KENYAN VOTE, COUNTED IN THE OPEN
        </text>
      </g>
      <rect x={0.75} y={0.75} width={W - 1.5} height={H - 1.5} rx={34} fill="none" stroke={INK} strokeOpacity={0.25} strokeWidth={1.5} />
    </svg>
  );
}

/** The card's own pattern on its own, for the public card check to show. */
export function CardPattern({ cardNumber, className }: { cardNumber: string; className?: string }) {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={className} role="img" aria-label={`Security pattern for card ${cardNumber}`}>
      <rect width={W} height={H} rx={34} fill={PAPER} />
      <Lines cardNumber={cardNumber} face="front" />
      <text x={40} y={H - 40} fontFamily={MONO} fontWeight={700} fontSize={33} letterSpacing={3.5} fill={INK}>
        {cardNumber}
      </text>
    </svg>
  );
}

/**
 * The page that prints: front and back at exact ID-card size with cut lines.
 * Rendered straight into <body> so that, when printing, CSS can hide everything
 * else on the page (see the print rules in globals.css).
 */
export function VoterCardPrintSheet({ data }: { data: VoterCardData }) {
  // true only in the browser, where document.body exists
  const mounted = useSyncExternalStore(noSubscribe, () => true, () => false);
  if (!mounted) return null;
  return createPortal(
    <div className="voter-card-print hidden print:block">
      <p style={{ fontFamily: SANS, fontSize: "9pt", color: SOFT, margin: "0 0 6mm" }}>
        E-ELECTIONS voter card · {data.cardNumber} · Cut along the dashed lines and laminate back to back.
      </p>
      <div style={{ display: "flex", gap: "10mm", flexWrap: "wrap" }}>
        <div className="crop-marks">
          <VoterCardFront data={data} className="card-face" />
        </div>
        <div className="crop-marks">
          <VoterCardBack data={data} className="card-face" />
        </div>
      </div>
    </div>,
    document.body
  );
}
