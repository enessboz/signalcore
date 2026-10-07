import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";
import "./design-system.css";
import { getLocale } from "@/lib/i18n";

const manrope = Manrope({
  subsets: ["latin", "latin-ext"],
  variable: "--font-manrope",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "SignalCore",
    template: "%s · SignalCore",
  },
  description:
    "Evidence-driven SEO intelligence and autonomous operations platform",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const locale = await getLocale();
  return (
    <html lang={locale}>
      <body className={manrope.variable}>{children}</body>
    </html>
  );
}
