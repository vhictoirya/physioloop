import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppWalletProvider } from "@/components/WalletProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "PhysioLoop — Physio Dashboard",
  description: "Clinical compliance marketplace on Solana",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50">
        <AppWalletProvider>{children}</AppWalletProvider>
      </body>
    </html>
  );
}
