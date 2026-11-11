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
      <body className="min-h-screen bg-[#090B0A] text-[#F1F0E8] antialiased selection:bg-[#C6F36A]/20 selection:text-[#C6F36A]">
        {children}
      </body>
    </html>
  );
}
