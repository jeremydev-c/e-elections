import type { Metadata, Viewport } from "next";
import { Instrument_Serif, JetBrains_Mono, Schibsted_Grotesk } from "next/font/google";
import { SiteNav } from "@/components/SiteNav";
import { SiteFooter } from "@/components/SiteFooter";
import { ToastProvider } from "@/components/Toast";
import { I18nProvider, LANG_BOOT_SCRIPT } from "@/lib/i18n/I18n";
import "./globals.css";

const schibsted = Schibsted_Grotesk({ subsets: ["latin"], variable: "--font-schibsted" });
const instrument = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-instrument" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });

export const metadata: Metadata = {
  title: {
    default: "E-ELECTIONS | Digital Electoral & Real-Time Tallying System",
    template: "%s | E-ELECTIONS",
  },
  description:
    "Secure biometric digital voting for Kenya: vote from anywhere, instant tallying and a tamper-proof SHA-256 vote ledger. In English and Kiswahili. KSEF / YSK 2027.",
};

export const viewport: Viewport = {
  themeColor: "#f3f1ea",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      className={`${schibsted.variable} ${instrument.variable} ${jetbrains.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Kiswahili readers: hide the page for the instant it takes to switch language. */}
        <script dangerouslySetInnerHTML={{ __html: LANG_BOOT_SCRIPT }} />
      </head>
      <body className="font-sans">
        <I18nProvider>
          <ToastProvider>
            <SiteNav />
            {children}
            <SiteFooter />
          </ToastProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
