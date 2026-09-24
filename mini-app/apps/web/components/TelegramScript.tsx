"use client";

import Script from "next/script";
import { tg } from "@/lib/tg.ts";

/** SDK availability must not gate React hydration or authenticated data reads. */
export function TelegramScript() {
  return <Script src="https://telegram.org/js/telegram-web-app.js?59" strategy="afterInteractive" onReady={() => {
    tg()?.ready();
    tg()?.expand();
  }} />;
}
