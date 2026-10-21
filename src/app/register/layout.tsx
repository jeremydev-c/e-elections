import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Voter Registration",
  description: "Register a voter with National ID, electoral region and biometric enrollment (face + fingerprint passkey).",
  robots: { index: false },
};

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return children;
}
