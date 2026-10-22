"use client";

import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import { Camera, Loader2, RotateCcw } from "lucide-react";
import type { AwsCredentials } from "@aws-amplify/ui-react-liveness";
import { useI18n } from "@/lib/i18n/I18n";

const AwsLivenessView = dynamic(() => import("@/components/AwsLivenessView"), {
  ssr: false,
  loading: () => <LoadingNote />,
});

/** What /api/face/aws-session returns. */
export type AwsSession = {
  sessionId: string;
  ticket: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration?: string };
};

type Props = {
  /** Asks the server for a new AWS liveness session (login or registration). */
  startSession: () => Promise<AwsSession>;
  /** Called once AWS has analysed the scan; the server redeems the ticket. */
  onComplete: (ticket: string, seconds: number) => Promise<void> | void;
  actionLabel: string;
};

type Phase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "scanning"; session: AwsSession; credentials: AwsCredentials }
  | { kind: "done"; seconds: number }
  | { kind: "error"; msg: string };

/**
 * Face scan through AWS Rekognition Face Liveness: AWS checks for a live
 * person and our server then matches the face against the register.
 */
export function AwsFaceScan({ startSession, onComplete, actionLabel }: Props) {
  const { t, serverText } = useI18n();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const startedAt = useRef(0);

  async function start() {
    setPhase({ kind: "starting" });
    try {
      startedAt.current = performance.now();
      const session = await startSession();
      const c = session.credentials;
      setPhase({
        kind: "scanning",
        session,
        credentials: {
          accessKeyId: c.accessKeyId,
          secretAccessKey: c.secretAccessKey,
          sessionToken: c.sessionToken,
          expiration: c.expiration ? new Date(c.expiration) : undefined,
        },
      });
    } catch (err) {
      setPhase({ kind: "error", msg: serverText((err as Error).message) });
    }
  }

  async function finish(ticket: string) {
    const seconds = Math.round((performance.now() - startedAt.current) / 100) / 10;
    setPhase({ kind: "done", seconds });
    await onComplete(ticket, seconds);
  }

  if (phase.kind === "scanning") {
    const { session, credentials } = phase;
    return (
      <div className="overflow-hidden rounded-2xl border border-line bg-paper">
        <AwsLivenessView
          sessionId={session.sessionId}
          region={session.region}
          credentials={credentials}
          onComplete={() => finish(session.ticket)}
          onCancel={() => setPhase({ kind: "idle" })}
          onError={(msg) =>
            setPhase({
              kind: "error",
              msg: /permission|NotAllowed/i.test(msg)
                ? t("faceScan.cameraDenied")
                : t("faceScan.aws.stopped", { msg }),
            })
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-2xl border border-line bg-paper-2/60 p-5 text-center">
      {phase.kind === "done" ? (
        <Note text={t("faceScan.aws.complete", { s: phase.seconds })} busy />
      ) : phase.kind === "starting" ? (
        <Note busy text={t("faceScan.aws.starting")} />
      ) : (
        <>
          {phase.kind === "error" && <p className="text-sm text-red-800">{phase.msg}</p>}
          <p className="text-sm text-ink-soft">{t("faceScan.aws.intro")}</p>
          <button
            type="button"
            onClick={start}
            className="inline-flex items-center gap-2 rounded-xl bg-forest px-5 py-2.5 text-sm font-semibold text-paper hover:bg-forest-deep"
          >
            {phase.kind === "error" ? <RotateCcw className="size-4" aria-hidden /> : <Camera className="size-4" aria-hidden />}
            {phase.kind === "error" ? t("common.tryAgain") : actionLabel}
          </button>
        </>
      )}
    </div>
  );
}

function LoadingNote() {
  const { t } = useI18n();
  return <Note busy text={t("faceScan.opening")} />;
}

function Note({ text, busy }: { text: string; busy?: boolean }) {
  return (
    <p className="flex items-center justify-center gap-2 py-6 text-sm text-ink-soft">
      {busy && <Loader2 className="size-4 animate-spin text-forest" aria-hidden />} {text}
    </p>
  );
}
