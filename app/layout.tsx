import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SignalCore",
  description: "Evidence-driven SEO, Sales and Development operating system",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
