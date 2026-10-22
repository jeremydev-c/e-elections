"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { en, type Dict } from "@/lib/i18n/en";
import { sw } from "@/lib/i18n/sw";

/**
 * English / Kiswahili for the whole site. Pages call t("section.key", { vars }).
 * The choice is kept in a cookie (ee_lang) for a year. Every Swahili text is typed against
 * the English dictionary, so a missing translation fails the build instead of shipping English.
 * Messages that come from the server (errors, scan hints) are translated on arrival by serverText().
 */

export type Lang = "en" | "sw";
type Vars = Record<string, string | number>;

const DICTS: Record<Lang, Dict> = { en, sw };
const COOKIE = "ee_lang";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function lookup(dict: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, k) => (node && typeof node === "object" ? (node as Record<string, unknown>)[k] : undefined), dict);
}

function fill(text: string, vars?: Vars) {
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;
}

function readCookie(): Lang | null {
  const m = typeof document === "undefined" ? null : document.cookie.match(/(?:^|;\s*)ee_lang=(en|sw)/);
  return (m?.[1] as Lang) ?? null;
}

type I18n = {
  lang: Lang;
  setLang: (l: Lang) => void;
  /** Text for a dictionary key, with {placeholders} filled in. */
  t: (key: string, vars?: Vars) => string;
  /** A list or object from the dictionary (steps, options...). */
  list: <T = string>(key: string) => T[];
  /** A message sent by the server (in English), in the current language. */
  serverText: (message: string | undefined | null) => string;
  /** Dates and numbers in the reader's language. */
  locale: string;
  /** "Nyeri County" / "Kieni Constituency" / "Gakawa Ward" / "Republic of Kenya" from the server, translated. */
  regionText: (label: string | undefined | null) => string;
};

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");
  const [ready, setReady] = useState(false);

  // Before the first paint: switch to the saved language (the page is hidden meanwhile).
  useIsoLayoutEffect(() => {
    const saved = readCookie();
    if (saved && saved !== "en") setLangState(saved);
    setReady(true);
  }, []);
  useIsoLayoutEffect(() => {
    if (!ready) return;
    document.documentElement.lang = lang;
    document.documentElement.classList.remove("lang-pending");
  }, [ready, lang]);

  const setLang = useCallback((l: Lang) => {
    document.cookie = `${COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
    setLangState(l);
  }, []);

  const value = useMemo<I18n>(() => {
    const dict = DICTS[lang];
    const t = (key: string, vars?: Vars) => {
      const v = lookup(dict, key) ?? lookup(en, key);
      if (typeof v !== "string") {
        if (process.env.NODE_ENV !== "production") console.warn(`i18n: missing text "${key}"`);
        return key;
      }
      return fill(v, vars);
    };
    const list = <T,>(key: string) => ((lookup(dict, key) ?? lookup(en, key) ?? []) as T[]);
    const serverText = (message: string | undefined | null) => {
      if (!message) return "";
      if (lang === "en") return message;
      const exact = (dict.server.exact as Record<string, string>)[message];
      if (exact) return exact;
      for (const [pattern, replacement, names] of SERVER_PATTERNS) {
        const m = message.match(pattern);
        if (!m) continue;
        const groups: Vars = Object.fromEntries(names.map((n, i) => [n, m[i + 1]]));
        // Seat names inside a message ("for President") in the reader's language too.
        if (typeof groups.seat === "string") {
          const key = (Object.keys(en.positions) as (keyof typeof en.positions)[]).find((k) => en.positions[k] === groups.seat);
          if (key) groups.seat = dict.positions[key];
        }
        return fill(lookup(dict, `server.patterns.${replacement}`) as string, groups);
      }
      return message;
    };
    const regionText = (label: string | undefined | null) => {
      if (!label) return "";
      if (label === "Republic of Kenya" || label === "National") return t("region.republic");
      const m = label.match(/^(.*) (County|Constituency|Ward)$/);
      if (!m) return label;
      return t(`region.${m[2].toLowerCase()}`, { name: m[1] });
    };
    return { lang, setLang, t, list, serverText, regionText, locale: lang === "sw" ? "sw-KE" : "en-KE" };
  }, [lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Server messages with numbers, names or dates inside: matched by pattern, translated by key. */
const SERVER_PATTERNS: [RegExp, string, string[]][] = [
  [/^Too many failed face scans\. Face Recognition is locked for (\d+)s\. Try Fingerprint instead\.$/, "faceLocked", ["s"]],
  [/^Too many face scans from this device\. Try again in (\d+)s\.$/, "tooManyScans", ["s"]],
  [/^Too many unknown ID lookups\. Try again in (\d+)s\.$/, "tooManyLookups", ["s"]],
  [/^Too many attempts\. Try again in (\d+) min\.$/, "tooManyAttempts", ["m"]],
  [/^ACCESS DENIED: National ID (\d+) has already cast a ballot at (.+)\. Double voting is strictly prevented\.$/, "alreadyVoted", ["id", "when"]],
  [/^Please choose a candidate for (.+)\.$/, "chooseCandidate", ["seat"]],
  [/^Invalid (.+) selection: that candidate is not on your ballot\.$/, "invalidSelection", ["seat"]],
  [/^Ballot #(\d+) still points to the ORIGINAL hash, so the link breaks\.$/, "nextLink", ["n"]],
];

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}

/** Inline script for the layout: hide the page until the saved language is applied (no English flash). */
export const LANG_BOOT_SCRIPT = `try{if(/(?:^|;\\s*)ee_lang=sw/.test(document.cookie)){var d=document.documentElement;d.classList.add("lang-pending");d.lang="sw";setTimeout(function(){d.classList.remove("lang-pending")},1500)}}catch(e){}`;
