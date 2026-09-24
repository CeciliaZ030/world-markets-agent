import type { Metadata } from "next";
import { TelegramScript } from "@/components/TelegramScript.tsx";
import "./globals.css";

export const metadata: Metadata = { title: "aomi mini app" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body><TelegramScript />{children}</body>
    </html>
  );
}
