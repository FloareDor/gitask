import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import { GTProvider, useLocale } from "gt-next";
import { getGT } from "gt-next/server";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export async function generateMetadata(): Promise<Metadata> {
  const gt = await getGT();
  return {
    title: gt("GitAsk: Ask any GitHub repo"),
    description: gt(
      "RAG in your browser. Index any GitHub repo and chat with it. WebGPU inference, AST chunking, hybrid search. No server. API keys encrypted locally."
    ),
  };
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = useLocale();

  return (
    <html lang={locale} suppressHydrationWarning>
      {/* Prevent flash of wrong theme on load */}
      <head>
        <script dangerouslySetInnerHTML={{ __html: `(function(){try{var t=localStorage.getItem('theme');if(t!=='dark')document.documentElement.setAttribute('data-theme','light');}catch(e){}})()` }} />
      </head>
      <body suppressHydrationWarning>
        <GTProvider>
          {children}
        </GTProvider>
        <Analytics />
      </body>
    </html>
  );
}
