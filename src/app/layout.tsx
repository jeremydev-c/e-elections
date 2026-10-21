import type { Metadata, Viewport } from "next";
import { Fraunces, JetBrains_Mono, Public_Sans } from "next/font/google";
import { SiteNav } from "@/components/SiteNav";
import { ToastProvider } from "@/components/Toast";
import "./globals.css";

const publicSans = Public_Sans({ subsets: ["latin"], variable: "--font-public-sans" });
const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-fraunces", axes: ["opsz", "SOFT"] });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });

export const metadata: Metadata = {
  title: {
    default: "E-ELECTIONS | Digital Electoral & Real-Time Tallying System",
    template: "%s | E-ELECTIONS",
  },
  description:
    "Secure biometric digital voting for Kenya: vote from anywhere, instant tallying and a tamper-proof SHA-256 vote ledger. KSEF / YSK 2027.",
};

export const viewport: Viewport = {
  themeColor: "#f4efe4",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth" className={`${publicSans.variable} ${fraunces.variable} ${jetbrains.variable}`}>
      <body className="font-sans">
        <ToastProvider>
          <SiteNav />
          {children}
          <footer className="mt-16 border-t border-line bg-paper-2/60 print:hidden">
            <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-xs text-ink-faint sm:flex-row sm:items-center sm:justify-between">
              <p>
                <span className="font-display text-sm font-semibold text-ink-soft">E-Elections Kenya</span> · Kenya Science
                &amp; Engineering Fair 2027 · Young Scientists Kenya 2027
              </p>
              <p>Demonstration system · all candidates are fictional</p>
            </div>
          </footer>
        </ToastProvider>
      </body>
    </html>
  );
}
