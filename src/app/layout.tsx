import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GitAsk — Instant AI for Any GitHub Repo",
  description:
    "A zero-cost, client-side RAG engine that turns any GitHub repository into an intelligent coding assistant using WebGPU.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
