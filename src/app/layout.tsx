import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VeriRelease — AI-Assisted Milestone Verification & Payment Authorization",
  description:
    "Verifiable milestone verification and payment authorization platform for software development contracts.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): React.ReactElement {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased selection:bg-sky-500/30 selection:text-sky-200">
        {children}
      </body>
    </html>
  );
}
