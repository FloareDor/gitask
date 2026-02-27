"use client";

import { ArchitectureDiagram } from "@/components/ArchitectureDiagram";
import { ModelSettings } from "@/components/ModelSettings";
import { STORAGE_COMPARISON } from "@/lib/eval-results";
import { detectWebGPUAvailability } from "@/lib/webgpu";
import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";

const CHAT_STORAGE_PREFIX = "gitask-chat-";

interface SavedChatEntry {
  key: string;
  owner: string;
  repo: string;
  chatCount: number;
  lastUpdated: number;
  label: string;
}

function buildChatLabel(messages: Array<{ role?: string; content?: string }>, fallback: string): string {
  const firstUserMessage = messages.find(
    (m) => m?.role === "user" && typeof m.content === "string" && m.content.trim().length > 0
  );
  if (!firstUserMessage || !firstUserMessage.content) return fallback;
  const compact = firstUserMessage.content.trim().replace(/\s+/g, " ");
  return compact.length > 36 ? `${compact.slice(0, 36)}...` : compact;
}

function parseSavedChatEntry(key: string, raw: string): SavedChatEntry | null {
  if (!key.startsWith(CHAT_STORAGE_PREFIX)) return null;
  const repoPath = key.slice(CHAT_STORAGE_PREFIX.length);
  const slashIndex = repoPath.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= repoPath.length - 1) return null;

  const owner = repoPath.slice(0, slashIndex);
  const repo = repoPath.slice(slashIndex + 1);

  try {
    const parsed = JSON.parse(raw) as
      | Array<{ role?: string; content?: string }>
      | {
          activeChatId?: string;
          sessions?: Array<{
            chat_id?: string;
            title?: string;
            updatedAt?: number;
            messages?: Array<{ role?: string; content?: string }>;
          }>;
        };

    // Legacy format: Message[]
    if (Array.isArray(parsed)) {
      const messages = parsed;
      if (messages.length === 0) return null;
      return {
        key,
        owner,
        repo,
        chatCount: 1,
        lastUpdated: 0,
        label: buildChatLabel(messages, "Chat 1"),
      };
    }

    if (!parsed || !Array.isArray(parsed.sessions) || parsed.sessions.length === 0) return null;
    const sessions = parsed.sessions.filter((session) => Array.isArray(session.messages) && session.messages.length > 0);
    if (sessions.length === 0) return null;

    const active = sessions.find((session) => session.chat_id === parsed.activeChatId) ?? sessions[0];
    const activeMessages = Array.isArray(active.messages) ? active.messages : [];
    const lastUpdated = sessions.reduce((maxTs, session) => {
      const ts = typeof session.updatedAt === "number" ? session.updatedAt : 0;
      return Math.max(maxTs, ts);
    }, 0);

    return {
      key,
      owner,
      repo,
      chatCount: sessions.length,
      lastUpdated,
      label: typeof active.title === "string" && active.title.trim().length > 0
        ? active.title
        : buildChatLabel(activeMessages, "Recent chat"),
    };
  } catch {
    return null;
  }
}

function NoWebGPUScreen() {
  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "24px",
      textAlign: "center" as const,
    }}>
      <div style={{
        maxWidth: "380px",
        padding: "40px 36px",
        display: "flex",
        flexDirection: "column" as const,
        alignItems: "center",
        gap: "16px",
        background: "var(--bg-card)",
        border: "2px solid var(--border)",
        borderRadius: "var(--radius)",
        boxShadow: "var(--shadow-brutal)",
      }}>
        <span style={{ fontSize: "48px", lineHeight: 1 }}>💻</span>
        <h2 style={{ fontSize: "22px", fontWeight: 800, letterSpacing: "-0.02em", fontFamily: "var(--font-display)" }}>
          WebGPU not supported
        </h2>
        <p style={{ fontSize: "14px", color: "var(--text-secondary)", lineHeight: 1.65 }}>
          This app needs WebGPU to run embeddings in your browser. Try{" "}
          <strong style={{ color: "var(--text-primary)" }}>Chrome 121+ (Android) or desktop Chrome/Edge</strong>.
          Also make sure you are on <strong style={{ color: "var(--text-primary)" }}>HTTPS</strong>.
        </p>
      </div>
    </div>
  );
}

export default function LandingPage() {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [savedChats, setSavedChats] = useState<SavedChatEntry[]>([]);
  const [isHowVisible, setIsHowVisible] = useState(false);
  const [gpuSupported, setGpuSupported] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const howSectionRef = useRef<HTMLElement>(null);
  const router = useRouter();

  const loadSavedChats = useCallback(() => {
    if (typeof window === "undefined") return;
    const entries: SavedChatEntry[] = [];
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(CHAT_STORAGE_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = parseSavedChatEntry(key, raw);
      if (parsed) entries.push(parsed);
    }

    entries.sort((a, b) => {
      if (a.lastUpdated !== b.lastUpdated) return b.lastUpdated - a.lastUpdated;
      return `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`);
    });
    setSavedChats(entries);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const availability = await Promise.race([
        detectWebGPUAvailability(),
        new Promise<{ supported: true; reason: "ok" }>((resolve) =>
          setTimeout(() => resolve({ supported: true, reason: "ok" }), 1500)
        ),
      ]);
      if (cancelled) return;

      setGpuSupported(availability.supported);
      if (!availability.supported) {
        console.info("WebGPU unavailable:", availability.reason, availability.error ?? "");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 600);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    const node = howSectionRef.current;
    if (!node) {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsHowVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.22 }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    loadSavedChats();
    const handleVisibility = () => {
      if (document.visibilityState === "visible") loadSavedChats();
    };
    window.addEventListener("focus", loadSavedChats);
    window.addEventListener("storage", loadSavedChats);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", loadSavedChats);
      window.removeEventListener("storage", loadSavedChats);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [loadSavedChats]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    const match = url.match(
      /(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/]+)\/([^\/\s]+)/
    );

    if (!match) {
      setError("Please enter a valid GitHub URL (e.g. https://github.com/owner/repo)");
      return;
    }

    const owner = match[1];
    const repo = match[2].replace(/\.git$/, "");
    router.push(`/${owner}/${repo}`);
  }

  function handleOpenSavedChat(owner: string, repo: string) {
    router.push(`/${owner}/${repo}`);
  }

  function handleDeleteSavedChat(storageKey: string) {
    if (typeof window !== "undefined") {
      const confirmed = window.confirm("Delete local chats for this repository?");
      if (!confirmed) return;
      localStorage.removeItem(storageKey);
      loadSavedChats();
    }
  }

  function handleDeleteAllSavedChats() {
    if (savedChats.length === 0) return;
    if (typeof window !== "undefined") {
      const confirmed = window.confirm("Delete all local chats across repositories?");
      if (!confirmed) return;
      for (const entry of savedChats) {
        localStorage.removeItem(entry.key);
      }
      setSavedChats([]);
    }
  }

  if (!gpuSupported) return <NoWebGPUScreen />;

  const projectRepoUrl = "https://github.com/FloareDor/gitask";

  return (
    <div style={{ ...styles.wrapper, overflowX: "hidden" }}>
      {/* Settings - fixed top-right */}
      <div style={styles.settingsFixed}>
        <ModelSettings />
      </div>

      {/* Decorative corner accent lines */}
      <div style={styles.cornerTL} />
      <div style={styles.cornerBR} />

      <main style={styles.main}>
        <div className="fade-in" style={styles.hero}>
          {/* Badge */}
          <div style={styles.badge}>
            <span style={styles.badgeDot} className="pulse" />
            Client-side · Free · No server
          </div>

          <h1 style={styles.title}>
            Turn any GitHub repo into a
            <span style={styles.gradient}> chat you can query</span>
          </h1>

          <p style={styles.subtitle}>
            Browser-native RAG. Embeddings, retrieval, and storage. All on-device
            via WebGPU. API keys encrypted locally.
          </p>

          {/* Search form */}
          <div style={styles.formWrapper}>
            <form
              onSubmit={handleSubmit}
              style={{
                ...styles.form,
                ...(isMobile && { flexDirection: "column" as const }),
              }}
            >
              <input
                className="input"
                type="text"
                placeholder="https://github.com/owner/repo"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                style={styles.urlInput}
                id="repo-url-input"
              />
              <button type="submit" className="btn btn-primary" id="go-btn" style={styles.goBtn}>
                Ask →
              </button>
            </form>
            {error && <p style={styles.error}>{error}</p>}
          </div>

          <div style={styles.quickLinks}>
            <a href="/ablation" style={styles.evalsLink} className="evals-link">
              Ablation
            </a>
            <a
              href={projectRepoUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={styles.starLink}
              className="star-link"
              aria-label="Star GitAsk on GitHub"
              title="Open GitAsk on GitHub"
            >
              <span style={styles.starIcon}>★ Star</span>
              <img
                alt="GitHub stars"
                src="https://img.shields.io/github/stars/FloareDor/gitask?style=social"
                style={styles.starBadge}
              />
            </a>
          </div>

          {savedChats.length > 0 && (
            <div style={styles.savedChatsCard}>
              <div style={styles.savedChatsHeader}>
                <strong style={styles.savedChatsTitle}>Recent Chats</strong>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={styles.savedChatsClearAllBtn}
                  onClick={handleDeleteAllSavedChats}
                >
                  Clear all chats
                </button>
              </div>
              <div style={styles.savedChatsList}>
                {savedChats.map((chat) => (
                  <div key={chat.key} style={styles.savedChatRow}>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={styles.savedChatOpenBtn}
                      onClick={() => handleOpenSavedChat(chat.owner, chat.repo)}
                      title={`Open ${chat.owner}/${chat.repo}`}
                    >
                      {chat.owner}/{chat.repo}
                    </button>
                    <span style={styles.savedChatMeta}>
                      {chat.chatCount} chat{chat.chatCount === 1 ? "" : "s"} · {chat.label}
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={styles.savedChatDeleteBtn}
                      onClick={() => handleDeleteSavedChat(chat.key)}
                      title="Delete local chats for this repo"
                    >
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Feature cards */}
          <div style={{
            ...styles.features,
            ...(isMobile && { gridTemplateColumns: "1fr" }),
          }}>
            {[
              { icon: "⚡", label: "WebGPU Inference", desc: "Embeddings computed on your GPU via WebGPU" },
              { icon: "🌲", label: "AST Chunking", desc: "Code split by syntax, not line count" },
              { icon: "🔍", label: "Hybrid Search", desc: "Combines vector and keyword search" },
              {
                icon: "🗜",
                label: "Binary Quantization",
                desc: `${STORAGE_COMPARISON.compressionRatio}x smaller index. ${STORAGE_COMPARISON.float32TotalKB.toFixed(0)}KB → ${STORAGE_COMPARISON.binaryTotalKB.toFixed(0)}KB for ${STORAGE_COMPARISON.exampleRepoChunks} chunks.`,
              },
              { icon: "🔐", label: "Your Key, Your Browser", desc: "API key encrypted and stored locally. Never touches a server." },
            ].map((f, i) => (
              <div
                key={f.label}
                className="feature-card"
                style={{
                  ...styles.featureCard,
                  ...(!isMobile && { gridColumn: i < 3 ? "span 2" : "span 3" }),
                }}
              >
                <span style={styles.featureIcon}>{f.icon}</span>
                <strong style={styles.featureLabel}>{f.label}</strong>
                <span style={styles.featureDesc}>{f.desc}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Architecture Diagram Section */}
        <section
          ref={howSectionRef}
          style={{
            ...styles.howSection,
            ...(isHowVisible ? styles.howSectionVisible : {}),
          }}
        >
          <div style={styles.howHeader}>
            <h2 style={styles.howTitle}>How It Works</h2>
          </div>

          <ArchitectureDiagram />
        </section>
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    overflow: "hidden",
  },
  /* Decorative corner lines — neobrutalism geometric accent */
  cornerTL: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "220px",
    height: "220px",
    borderRight: "2px solid #2d2d42",
    borderBottom: "2px solid #2d2d42",
    borderBottomRightRadius: "0",
    pointerEvents: "none",
    opacity: 0.5,
  },
  cornerBR: {
    position: "absolute",
    bottom: 0,
    right: 0,
    width: "220px",
    height: "220px",
    borderLeft: "2px solid #2d2d42",
    borderTop: "2px solid #2d2d42",
    pointerEvents: "none",
    opacity: 0.5,
  },
  main: {
    position: "relative",
    zIndex: 1,
    width: "100%",
    maxWidth: "820px",
    padding: "40px 24px",
    textAlign: "center",
  },
  hero: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "28px",
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 16px",
    borderRadius: "2px",
    fontSize: "12px",
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase" as const,
    color: "var(--text-secondary)",
    background: "var(--bg-card)",
    border: "2px solid var(--border)",
    fontFamily: "var(--font-mono)",
  },
  badgeDot: {
    width: "7px",
    height: "7px",
    borderRadius: "50%",
    background: "var(--success)",
    display: "inline-block",
  },
  title: {
    fontSize: "clamp(2rem, 5vw, 3.4rem)",
    fontWeight: 800,
    lineHeight: 1.1,
    letterSpacing: "-0.03em",
    fontFamily: "var(--font-display)",
  },
  gradient: {
    background: "linear-gradient(135deg, var(--accent), #a78bfa, #60a5fa)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
  subtitle: {
    fontSize: "16px",
    color: "var(--text-secondary)",
    lineHeight: 1.65,
    maxWidth: "540px",
  },
  formWrapper: {
    width: "100%",
    maxWidth: "620px",
    display: "flex",
    flexDirection: "column" as const,
    gap: "10px",
  },
  form: {
    display: "flex",
    gap: "12px",
    width: "100%",
  },
  urlInput: {
    flex: 1,
    fontSize: "15px",
  },
  goBtn: {
    flexShrink: 0,
    padding: "12px 24px",
    fontSize: "15px",
    fontFamily: "var(--font-display)",
    fontWeight: 700,
  },
  settingsFixed: {
    position: "fixed",
    top: "20px",
    right: "20px",
    zIndex: 50,
  },
  error: {
    color: "var(--error)",
    fontSize: "13px",
    textAlign: "left" as const,
    fontFamily: "var(--font-mono)",
    padding: "8px 12px",
    background: "rgba(239,68,68,0.08)",
    border: "2px solid rgba(239,68,68,0.3)",
    borderRadius: "var(--radius-sm)",
  },
  evalsLink: {
    fontSize: "13px",
    fontWeight: 600,
    color: "var(--text-secondary)",
    textDecoration: "none",
    padding: "8px 16px",
    borderRadius: "var(--radius-sm)",
    border: "2px solid var(--border)",
    transition: "all 0.1s ease",
    background: "var(--bg-card)",
  },
  quickLinks: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    flexWrap: "wrap" as const,
    justifyContent: "center",
  },
  starLink: {
    fontSize: "13px",
    fontWeight: 600,
    color: "var(--text-primary)",
    textDecoration: "none",
    padding: "7px 12px",
    borderRadius: "var(--radius-sm)",
    border: "2px solid var(--border)",
    transition: "all 0.1s ease",
    background: "var(--bg-card)",
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
  },
  starIcon: {
    fontSize: "13px",
    fontWeight: 700,
  },
  starBadge: {
    height: "20px",
    width: "auto",
    display: "block",
  },
  features: {
    display: "grid",
    gridTemplateColumns: "repeat(6, 1fr)",
    gap: "12px",
    width: "100%",
    marginTop: "16px",
  },
  featureCard: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    gap: "6px",
    padding: "20px 16px",
    textAlign: "center" as const,
    background: "var(--bg-card)",
    border: "2px solid var(--border)",
    borderRadius: "var(--radius)",
    boxShadow: "3px 3px 0 var(--accent)",
    transition: "transform 0.1s ease, box-shadow 0.1s ease, border-color 0.1s ease",
    cursor: "default",
  },
  featureIcon: {
    fontSize: "22px",
    lineHeight: 1,
    marginBottom: "2px",
  },
  featureLabel: {
    fontSize: "13px",
    fontWeight: 700,
    fontFamily: "var(--font-display)",
  },
  featureDesc: {
    fontSize: "12px",
    color: "var(--text-secondary)",
    lineHeight: 1.5,
  },
  savedChatsCard: {
    width: "100%",
    maxWidth: "620px",
    border: "2px solid var(--border)",
    borderRadius: "var(--radius)",
    background: "var(--bg-card)",
    boxShadow: "3px 3px 0 var(--accent)",
    padding: "12px",
    display: "flex",
    flexDirection: "column" as const,
    gap: "8px",
  },
  savedChatsHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "10px",
  },
  savedChatsTitle: {
    fontSize: "13px",
    fontFamily: "var(--font-display)",
    letterSpacing: "0.04em",
    textTransform: "uppercase" as const,
    color: "var(--text-secondary)",
  },
  savedChatsClearAllBtn: {
    fontSize: "11px",
    padding: "4px 8px",
    color: "var(--text-muted)",
  },
  savedChatsList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "6px",
  },
  savedChatRow: {
    display: "grid",
    gridTemplateColumns: "minmax(160px, auto) 1fr auto",
    alignItems: "center",
    gap: "8px",
    border: "2px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    background: "var(--bg-secondary)",
    padding: "8px",
  },
  savedChatOpenBtn: {
    justifyContent: "flex-start",
    width: "100%",
    fontSize: "12px",
    padding: "6px 8px",
    border: "none",
    boxShadow: "none",
    color: "var(--accent)",
    fontFamily: "var(--font-mono)",
    fontWeight: 700,
    minWidth: 0,
  },
  savedChatMeta: {
    fontSize: "11px",
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono)",
    textAlign: "left" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  savedChatDeleteBtn: {
    fontSize: "11px",
    padding: "6px 8px",
    color: "var(--error)",
    border: "none",
    boxShadow: "none",
  },
  howSection: {
    width: "100%",
    marginTop: "120px",
    opacity: 0,
    transform: "translateY(24px)",
    transition: "opacity 0.5s ease, transform 0.5s ease",
  },
  howSectionVisible: {
    opacity: 1,
    transform: "translateY(0)",
  },
  howHeader: {
    textAlign: "center" as const,
    marginBottom: "28px",
  },
  howTitle: {
    fontSize: "clamp(1.5rem, 2.4vw, 2rem)",
    fontWeight: 800,
    letterSpacing: "-0.02em",
    fontFamily: "var(--font-display)",
  },
};
