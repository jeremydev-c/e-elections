"use client";

import { FaceLivenessDetectorCore, type AwsCredentials } from "@aws-amplify/ui-react-liveness";
import { ThemeProvider, type Theme } from "@aws-amplify/ui-react";
import "@aws-amplify/ui-react/styles.css";
import "@aws-amplify/ui-react-liveness/styles.css";

/** AWS's scanner in the site's own colours (forest green on paper). */
const theme: Theme = {
  name: "e-elections",
  tokens: {
    colors: {
      primary: {
        10: "#e6efe8",
        20: "#c5dccb",
        40: "#5f9372",
        60: "#2c6b47",
        80: "#1f5a39",
        90: "#18492e",
        100: "#143d26",
      },
    },
    radii: { small: "8px", medium: "12px", large: "16px" },
  },
};

export type AwsLivenessViewProps = {
  sessionId: string;
  region: string;
  credentials: AwsCredentials;
  onComplete: () => void;
  onError: (message: string) => void;
  onCancel: () => void;
};

/** Loaded on demand (it pulls in AWS's camera and streaming code), so pages stay light. */
export default function AwsLivenessView({ sessionId, region, credentials, onComplete, onError, onCancel }: AwsLivenessViewProps) {
  return (
    <ThemeProvider theme={theme}>
      <FaceLivenessDetectorCore
        sessionId={sessionId}
        region={region}
        disableStartScreen
        onAnalysisComplete={async () => onComplete()}
        onUserCancel={onCancel}
        onError={(e) => onError(e.error?.message || String(e.state))}
        config={{ credentialProvider: async () => credentials }}
        displayText={{
          hintCenterFaceText: "Fit your face in the oval",
          hintMoveFaceFrontOfCameraText: "Look at the camera",
          hintTooFarText: "Move closer",
          hintHoldFaceForFreshnessText: "Hold still",
        }}
      />
    </ThemeProvider>
  );
}
