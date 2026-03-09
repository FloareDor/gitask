"use client";

import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    try {
      const saved = localStorage.getItem("theme") as "dark" | "light" | null;
      const initial = saved ?? "dark";
      setTheme(initial);
      if (initial === "light") {
        document.documentElement.setAttribute("data-theme", "light");
      } else {
        document.documentElement.removeAttribute("data-theme");
      }
    } catch {
      // ignore
    }
  }, []);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try { localStorage.setItem("theme", next); } catch { /* ignore */ }
    if (next === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  };

  return (
    <button
      onClick={toggle}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 12px",
        border: "2px solid var(--page-border)",
        background: "transparent",
        color: "var(--page-text-dim)",
        cursor: "pointer",
        fontFamily: "var(--font-mono)",
        fontSize: "11px",
        fontWeight: 600,
        letterSpacing: "0.05em",
        transition: "color 0.15s, border-color 0.15s",
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = "#16a34a";
        (e.currentTarget as HTMLButtonElement).style.color = "#16a34a";
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--page-border)";
        (e.currentTarget as HTMLButtonElement).style.color = "var(--page-text-dim)";
      }}
    >
      {theme === "dark" ? "◑ Light" : "◐ Dark"}
    </button>
  );
}
