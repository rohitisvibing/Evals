import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { getSessionUser } from "@/lib/auth";
import { getMonthlyUsage } from "@/lib/quota";
import { supabaseServer } from "@/lib/supabase/server";
import { Header } from "@/components/Header";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Decision Model Observatory",
  description: "Jev vs. an LLM judge on evidence-grounded financial claims.",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await getSessionUser().catch(() => null);
  const used = user ? await getMonthlyUsage(await supabaseServer(), user.id).catch(() => 0) : null;
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} font-sans min-h-screen flex flex-col`}>
        <Header user={user} used={used} />
        <main className="flex-1">{children}</main>
        <footer className="border-t border-line">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 py-5 text-[12px] text-muted">
            Experimental research tool. Model verdicts are not verified facts and not investment advice.
          </div>
        </footer>
      </body>
    </html>
  );
}
