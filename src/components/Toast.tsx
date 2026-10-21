"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { CheckCircle2, Info, ShieldAlert, X } from "lucide-react";

type Kind = "success" | "error" | "info";
type ToastItem = { id: number; kind: Kind; title: string; body?: string };

type ToastApi = {
  success: (title: string, body?: string) => void;
  error: (title: string, body?: string) => void;
  info: (title: string, body?: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

const STYLES: Record<Kind, { box: string; icon: typeof Info }> = {
  success: { box: "border-forest/30 bg-forest-soft text-forest-deep", icon: CheckCircle2 },
  error: { box: "border-clay/50 bg-clay-soft text-clay", icon: ShieldAlert },
  info: { box: "border-line-strong bg-surface text-ink", icon: Info },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (kind: Kind, title: string, body?: string) => {
      const id = nextId.current++;
      setItems((list) => [...list.slice(-3), { id, kind, title, body }]);
      setTimeout(() => dismiss(id), kind === "error" ? 7000 : 4500);
    },
    [dismiss]
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (t, b) => push("success", t, b),
      error: (t, b) => push("error", t, b),
      info: (t, b) => push("info", t, b),
    }),
    [push]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:right-4 sm:items-end"
        aria-live="polite"
      >
        {items.map((t) => {
          const { box, icon: Icon } = STYLES[t.kind];
          return (
            <div
              key={t.id}
              role={t.kind === "error" ? "alert" : "status"}
              className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border p-4 shadow-[0_12px_32px_-12px_rgb(31_34_25/0.35)] animate-fade-up ${box}`}
            >
              <Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{t.title}</p>
                {t.body && <p className="mt-0.5 break-words text-xs opacity-80">{t.body}</p>}
              </div>
              <button onClick={() => dismiss(t.id)} className="opacity-60 hover:opacity-100" aria-label="Dismiss">
                <X className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
