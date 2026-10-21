import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Official Ballot",
  description: "Your location-aware ballot for all six elective seats.",
  robots: { index: false },
};

export default function BallotLayout({ children }: { children: React.ReactNode }) {
  return children;
}
