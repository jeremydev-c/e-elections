import path from "path";
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// AWS Face Liveness (NEXT_PUBLIC_FACE_PROVIDER=aws) downloads its face model from
// AWS's CDN and streams the camera to Rekognition in the configured region.
const awsRegion = process.env.AWS_REGION || "us-east-1";
const awsLiveness =
  process.env.NEXT_PUBLIC_FACE_PROVIDER === "aws"
    ? ` https://cdn.liveness.rekognition.amazonaws.com wss://streaming-rekognition.${awsRegion}.amazonaws.com https://streaming-rekognition.${awsRegion}.amazonaws.com`
    : "";

/**
 * Content Security Policy: only this origin may run scripts, load data or
 * frame the app. 'unsafe-eval' is needed by Next.js hot reload in dev only;
 * 'wasm-unsafe-eval' lets the face-recognition engine use WebAssembly.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${awsLiveness}${isDev ? " ws: wss:" : ""}`,
  "media-src 'self' blob: mediastream:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  {
    key: "Permissions-Policy",
    value:
      "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), " +
      "publickey-credentials-get=(self), publickey-credentials-create=(self)",
  },
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
];

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  // The server face engine (lib/faceEngine.ts) uses native code: load these from node_modules, don't bundle them.
  serverExternalPackages: ["onnxruntime-node", "sharp"],
  // A stray package-lock.json in the parent Documents folder makes Turbopack
  // guess the wrong workspace root. Pin it to this project folder.
  turbopack: {
    root: path.join(__dirname),
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
      // The face tracker (MediaPipe, ~17 MB) never changes between releases: let phones keep it for a month.
      { source: "/mediapipe/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=2592000, stale-while-revalidate=86400" }] },
    ];
  },
};

export default nextConfig;
