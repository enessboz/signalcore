import type { Metadata } from "next";
import "./globals.css";
import "./design-system.css";
import { getLocale } from "@/lib/i18n";

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
      <body>{children}</body>
    </html>
  );
}
