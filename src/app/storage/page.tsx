"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ModelSettings } from "@/components/ModelSettings";
import { ThemeToggle } from "@/components/ThemeToggle";

// ── Types ─────────────────────────────────────────────────────────────────────

interface RepoEmbeddingEntry {
  key: string;
  owner: string;
  repo: string;
  sha: string;
  timestamp: number;
  chunkCount: number;
  fileCount: number;
  embeddingModel: string;
  estimatedBytes: number;
}

interface ChatEntry {
  storageKey: string;
  chatCount: number;
  messageCount: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CHAT_PREFIX = "gitask-chat-";
const IDB_NAME = "gitask-cache";
const IDB_VERSION = 1;
// 384 floats × 8 bytes avg JSON + ~300 bytes text/metadata per chunk
const BYTES_PER_CHUNK = 3372 + 300;

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelTime(ts: number): string {
  if (!ts) return "unknown";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return `${Math.floor(s / 86400 / 7)}w ago`;
}

function shortSha(sha: string): string {
  return sha ? sha.slice(0, 7) : "—";
}

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("repos")) {
        req.result.createObjectStore("repos");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadRepoEntries(): Promise<RepoEmbeddingEntry[]> {
  const db = await openIDB();
  return new Promise((resolve) => {
    const tx = db.transaction("repos", "readonly");
    const store = tx.objectStore("repos");
    const keysReq = store.getAllKeys();

    keysReq.onsuccess = () => {
      const allKeys = keysReq.result as string[];
      const repoKeys = allKeys.filter((k) => !k.endsWith("-partial"));

      if (repoKeys.length === 0) {
        db.close();
        resolve([]);
        return;
      }

      const results: RepoEmbeddingEntry[] = [];
      let remaining = repoKeys.length;

      for (const key of repoKeys) {
        const getReq = store.get(key);
        getReq.onsuccess = () => {
          const data = getReq.result;
          if (data && Array.isArray(data.chunks)) {
            const slash = key.indexOf("/");
            const owner = key.slice(0, slash);
            const repo = key.slice(slash + 1);
            const chunkCount: number = data.chunks.length;
            const fileSet = new Set<string>(
              data.chunks.map((c: { filePath: string }) => c.filePath)
            );
            results.push({
              key,
              owner,
              repo,
              sha: typeof data.sha === "string" ? data.sha : "",
              timestamp: typeof data.timestamp === "number" ? data.timestamp : 0,
              chunkCount,
              fileCount: fileSet.size,
              embeddingModel:
                typeof data.embeddingModel === "string"
                  ? data.embeddingModel.split("/").pop() ?? data.embeddingModel
                  : "unknown",
              estimatedBytes: chunkCount * BYTES_PER_CHUNK,
            });
          }
          if (--remaining === 0) {
            db.close();
            results.sort((a, b) => b.estimatedBytes - a.estimatedBytes);
            resolve(results);
          }
        };
        getReq.onerror = () => {
          if (--remaining === 0) {
            db.close();
            results.sort((a, b) => b.estimatedBytes - a.estimatedBytes);
            resolve(results);
          }
        };
      }
    };

    keysReq.onerror = () => {
      db.close();
      resolve([]);
    };
  });
}

async function deleteRepoIDB(key: string): Promise<void> {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("repos", "readwrite");
    const store = tx.objectStore("repos");
    store.delete(key);
    store.delete(`${key}-partial`);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

async function clearAllIDB(): Promise<void> {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("repos", "readwrite");
    tx.objectStore("repos").clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

function loadChatMap(): Map<string, ChatEntry> {
  const map = new Map<string, ChatEntry>();
  if (typeof window === "undefined") return map;

  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(CHAT_PREFIX)) continue;
    const repoPath = key.slice(CHAT_PREFIX.length);
    const slash = repoPath.indexOf("/");
    if (slash <= 0) continue;

    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      let chatCount = 0;
      let messageCount = 0;

      if (Array.isArray(parsed)) {
        chatCount = parsed.length > 0 ? 1 : 0;
        messageCount = parsed.length;
      } else if (parsed?.sessions && Array.isArray(parsed.sessions)) {
        chatCount = parsed.sessions.length;
        messageCount = parsed.sessions.reduce(
          (sum: number, s: { messages?: unknown[] }) =>
            sum + (s.messages?.length ?? 0),
          0
        );
      }

      map.set(repoPath, { storageKey: key, chatCount, messageCount });
    } catch {
      /* skip malformed */
    }
  }
  return map;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function StoragePage() {
  const [repos, setRepos] = useState<RepoEmbeddingEntry[]>([]);
  const [chatMap, setChatMap] = useState<Map<string, ChatEntry>>(new Map());
  const [loading, setLoading] = useState(true);
  const [mounted, setMounted] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [deletingAll, setDeletingAll] = useState(false);
  const router = useRouter();

  const load = useCallback(async () => {
    setLoading(true);
    const [entries, chats] = await Promise.all([
      loadRepoEntries(),
      Promise.resolve(loadChatMap()),
    ]);
    setRepos(entries);
    setChatMap(chats);
    setLoading(false);
    setTimeout(() => setMounted(true), 20);
  }, []);

  useEffect(() => { load(); }, [load]);

  const totalBytes = repos.reduce((s, r) => s + r.estimatedBytes, 0);
  const totalChats = [...chatMap.values()].reduce((s, c) => s + c.chatCount, 0);
  const maxBytes = repos[0]?.estimatedBytes || 1;

  async function handleDelete(key: string) {
    setDeletingKey(key);
    await deleteRepoIDB(key);
    const entry = repos.find((r) => r.key === key);
    if (entry) localStorage.removeItem(`${CHAT_PREFIX}${entry.owner}/${entry.repo}`);
    await load();
    setDeletingKey(null);
    setConfirmKey(null);
  }

  async function handleClearAll() {
    setDeletingAll(true);
    await clearAllIDB();
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(CHAT_PREFIX)) localStorage.removeItem(key);
    }
    await load();
    setDeletingAll(false);
    setConfirmAll(false);
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={{
      minHeight: "100vh",
      background: "var(--page-bg)",
      color: "var(--page-text)",
      fontFamily: "var(--font-sans)",
    }}>

      {/* NAV */}
      <nav style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "20px 40px",
        borderBottom: "1px solid var(--page-border)",
        background: "var(--page-bg)",
        position: "sticky",
        top: 0,
        zIndex: 40,
      }}>
        <button
          onClick={() => router.push("/")}
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 800,
            fontSize: "1.1rem",
            letterSpacing: "-0.02em",
            color: "var(--page-text)",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 0,
          }}
        >
          gitask
        </button>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <ModelSettings />
          <ThemeToggle />
          <a
            href="https://github.com/FloareDor/gitask"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: "13px",
              fontWeight: 600,
              color: "var(--page-text)",
              textDecoration: "none",
              border: "1px solid var(--page-border)",
              padding: "6px 14px",
              fontFamily: "var(--font-sans)",
            }}
          >
            GitHub ↗
          </a>
        </div>
      </nav>

      {/* HEADER */}
      <section style={{
        padding: "64px 40px 48px",
        borderBottom: "1px solid var(--page-border)",
      }}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          <p style={{
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            color: "var(--page-text-muted)",
            marginBottom: 12,
          }}>
            Local data
          </p>
          <h1 style={{
            fontFamily: "var(--font-display)",
            fontSize: "clamp(2.5rem, 6vw, 4rem)",
            fontWeight: 800,
            letterSpacing: "-0.04em",
            color: "var(--page-text)",
            lineHeight: 1,
            marginBottom: 40,
          }}>
            Storage
          </h1>

          {/* 3 summary stats */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 0,
          }}>
            {[
              { value: loading ? "—" : String(repos.length), label: "repos indexed" },
              { value: loading ? "—" : formatBytes(totalBytes), label: "on-device" },
              { value: loading ? "—" : String(totalChats), label: "saved chats" },
            ].map((stat, i, arr) => (
              <div
                key={stat.label}
                style={{
                  padding: "24px 28px",
                  border: "1px solid var(--page-border)",
                  borderRight: i < arr.length - 1 ? "none" : "1px solid var(--page-border)",
                  background: "var(--page-surface)",
                }}
              >
                <div style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "clamp(1.5rem, 3vw, 2.2rem)",
                  fontWeight: 700,
                  color: "#16a34a",
                  lineHeight: 1,
                  marginBottom: 6,
                }}>
                  {stat.value}
                </div>
                <div style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "11px",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "var(--page-text-muted)",
                }}>
                  {stat.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* REPO LIST */}
      <section style={{ padding: "48px 40px 80px" }}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>

          {/* Skeleton */}
          {loading && (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {[1, 2, 3].map((i) => (
                <div key={i} style={{
                  height: 88,
                  background: "var(--page-surface)",
                  border: "1px solid var(--page-border)",
                  borderTop: i === 1 ? "1px solid var(--page-border)" : "none",
                  opacity: 0.4 + i * 0.1,
                  animation: "pulse 1.8s ease-in-out infinite",
                }} />
              ))}
            </div>
          )}

          {/* Empty state */}
          {!loading && repos.length === 0 && (
            <div style={{
              textAlign: "center",
              padding: "72px 24px",
              border: "1px solid var(--page-border)",
              background: "var(--page-surface)",
            }}>
              <p style={{
                color: "var(--page-text-dim)",
                fontSize: "0.95rem",
                marginBottom: 20,
                lineHeight: 1.6,
              }}>
                No repos indexed yet. Index one from the home page —<br />
                everything stays in your browser.
              </p>
              <button
                onClick={() => router.push("/")}
                style={{
                  padding: "11px 24px",
                  background: "#16a34a",
                  color: "#fff",
                  border: "none",
                  fontFamily: "var(--font-display)",
                  fontWeight: 700,
                  fontSize: "0.9rem",
                  cursor: "pointer",
                  letterSpacing: "-0.01em",
                }}
              >
                Index a repo →
              </button>
            </div>
          )}

          {/* Repo cards */}
          {!loading && repos.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {repos.map((repo, i) => {
                const chat = chatMap.get(repo.key);
                const barPct = Math.max(3, (repo.estimatedBytes / maxBytes) * 100);
                const isExpanded = expandedKey === repo.key;
                const isConfirming = confirmKey === repo.key;
                const isDeleting = deletingKey === repo.key;
                const chatLabel = chat && chat.chatCount > 0
                  ? `${chat.chatCount} chat${chat.chatCount !== 1 ? "s" : ""}`
                  : "no chats";

                return (
                  <div
                    key={repo.key}
                    role="button"
                    tabIndex={0}
                    onClick={() => { if (!isConfirming && !isDeleting) router.push(`/${repo.owner}/${repo.repo}`); }}
                    onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !isConfirming && !isDeleting) router.push(`/${repo.owner}/${repo.repo}`); }}
                    style={{
                      borderTop: i === 0 ? "1px solid var(--page-border)" : "none",
                      borderLeft: "1px solid var(--page-border)",
                      borderRight: "1px solid var(--page-border)",
                      borderBottom: "1px solid var(--page-border)",
                      background: isDeleting ? "var(--page-surface)" : "var(--page-bg)",
                      opacity: isDeleting ? 0.35 : mounted ? 1 : 0,
                      cursor: isConfirming || isDeleting ? "default" : "pointer",
                      transition: `opacity 0.28s ease ${i * 0.04}s, transform 0.1s ease, box-shadow 0.1s ease, border-color 0.1s ease, background 0.15s`,
                      padding: "24px 28px",
                    }}
                    onMouseEnter={(e) => {
                      if (isConfirming || isDeleting) return;
                      const el = e.currentTarget as HTMLElement;
                      el.style.transform = "translate(-3px, -3px)";
                      el.style.boxShadow = "3px 3px 0 #16a34a";
                      el.style.borderColor = "#16a34a";
                    }}
                    onMouseLeave={(e) => {
                      const el = e.currentTarget as HTMLElement;
                      el.style.transform = "";
                      el.style.boxShadow = "";
                      el.style.borderColor = "";
                    }}
                  >
                    {/* ── Main row ── */}
                    <div style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 16,
                      flexWrap: "wrap",
                    }}>
                      {/* Repo name */}
                      <span
                        title={`${repo.owner}/${repo.repo}`}
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: "0.95rem",
                          fontWeight: 700,
                          color: "var(--page-text)",
                          flexShrink: 0,
                          maxWidth: 220,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          display: "inline-block",
                        }}
                      >
                        <span style={{ color: "var(--page-text-muted)", fontWeight: 400 }}>{repo.owner}/</span>
                        {repo.repo}
                      </span>

                      {/* Storage bar + size */}
                      <div style={{ flex: 1, minWidth: 80, display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{
                          flex: 1,
                          height: 3,
                          background: "var(--page-border)",
                          position: "relative",
                          overflow: "hidden",
                        }}>
                          <div style={{
                            position: "absolute",
                            left: 0, top: 0,
                            height: "100%",
                            width: `${barPct}%`,
                            background: "#16a34a",
                            transition: "width 0.5s ease",
                          }} />
                        </div>
                        <span style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: "12px",
                          fontWeight: 600,
                          color: "#16a34a",
                          flexShrink: 0,
                        }}>
                          {formatBytes(repo.estimatedBytes)}
                        </span>
                      </div>

                      {/* Meta: age · chats */}
                      <span style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "12px",
                        color: "var(--page-text-muted)",
                        flexShrink: 0,
                        whiteSpace: "nowrap",
                      }}>
                        {formatRelTime(repo.timestamp)} · {chatLabel}
                      </span>

                      {/* Actions */}
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0, marginLeft: "auto" }}>
                        {isConfirming ? (
                          <>
                            <span style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: "11px",
                              color: "var(--page-text-muted)",
                            }}>
                              Delete?
                            </span>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleDelete(repo.key); }}
                              disabled={isDeleting}
                              style={{
                                padding: "5px 12px",
                                background: "#dc2626",
                                color: "#fff",
                                border: "none",
                                fontFamily: "var(--font-mono)",
                                fontSize: "12px",
                                fontWeight: 700,
                                cursor: "pointer",
                              }}
                            >
                              Yes
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); setConfirmKey(null); }}
                              style={{
                                padding: "5px 12px",
                                background: "none",
                                color: "var(--page-text-muted)",
                                border: "1px solid var(--page-border)",
                                fontFamily: "var(--font-mono)",
                                fontSize: "12px",
                                cursor: "pointer",
                              }}
                            >
                              No
                            </button>
                          </>
                        ) : (
                          <>
                            {/* Details toggle */}
                            <button
                              onClick={(e) => { e.stopPropagation(); setExpandedKey(isExpanded ? null : repo.key); }}
                              style={{
                                padding: "5px 12px",
                                background: "none",
                                color: isExpanded ? "var(--page-text)" : "var(--page-text-muted)",
                                border: "1px solid var(--page-border)",
                                fontFamily: "var(--font-mono)",
                                fontSize: "11px",
                                cursor: "pointer",
                                letterSpacing: "0.04em",
                                transition: "color 0.15s, border-color 0.15s",
                              }}
                              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--page-text)"; }}
                              onMouseLeave={(e) => {
                                if (!isExpanded) (e.currentTarget as HTMLElement).style.color = "var(--page-text-muted)";
                              }}
                            >
                              {isExpanded ? "Details ↑" : "Details ↓"}
                            </button>

                            {/* Open */}
                            <button
                              onClick={(e) => { e.stopPropagation(); router.push(`/${repo.owner}/${repo.repo}`); }}
                              style={{
                                padding: "5px 14px",
                                background: "none",
                                color: "#16a34a",
                                border: "1px solid #16a34a",
                                fontFamily: "var(--font-display)",
                                fontSize: "13px",
                                fontWeight: 700,
                                cursor: "pointer",
                                transition: "background 0.15s, color 0.15s",
                              }}
                              onMouseEnter={(e) => {
                                const el = e.currentTarget as HTMLElement;
                                el.style.background = "#16a34a";
                                el.style.color = "#fff";
                              }}
                              onMouseLeave={(e) => {
                                const el = e.currentTarget as HTMLElement;
                                el.style.background = "none";
                                el.style.color = "#16a34a";
                              }}
                            >
                              Open →
                            </button>

                            {/* Delete */}
                            <button
                              onClick={(e) => { e.stopPropagation(); setConfirmKey(repo.key); }}
                              title="Delete embeddings + chats"
                              style={{
                                padding: "5px 12px",
                                background: "none",
                                color: "var(--page-text-muted)",
                                border: "1px solid var(--page-border)",
                                fontFamily: "var(--font-mono)",
                                fontSize: "12px",
                                cursor: "pointer",
                                transition: "border-color 0.15s, color 0.15s",
                              }}
                              onMouseEnter={(e) => {
                                const el = e.currentTarget as HTMLElement;
                                el.style.borderColor = "#dc2626";
                                el.style.color = "#dc2626";
                              }}
                              onMouseLeave={(e) => {
                                const el = e.currentTarget as HTMLElement;
                                el.style.borderColor = "var(--page-border)";
                                el.style.color = "var(--page-text-muted)";
                              }}
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {/* ── Details panel (expanded) ── */}
                    {isExpanded && (
                      <div onClick={(e) => e.stopPropagation()} style={{
                        marginTop: 18,
                        paddingTop: 18,
                        borderTop: "1px solid var(--page-border)",
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                        gap: 0,
                      }}>
                        {[
                          { label: "Chunks", value: repo.chunkCount.toLocaleString() },
                          { label: "Files", value: repo.fileCount.toLocaleString() },
                          { label: "Model", value: repo.embeddingModel },
                          { label: "Commit", value: shortSha(repo.sha) },
                        ].map((item, di, arr) => (
                          <div key={item.label} style={{
                            padding: "14px 16px",
                            border: "1px solid var(--page-border)",
                            borderRight: di < arr.length - 1 ? "none" : "1px solid var(--page-border)",
                            background: "var(--page-surface)",
                          }}>
                            <div style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: "11px",
                              textTransform: "uppercase",
                              letterSpacing: "0.08em",
                              color: "var(--page-text-muted)",
                              marginBottom: 4,
                            }}>
                              {item.label}
                            </div>
                            <div style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: "13px",
                              fontWeight: 600,
                              color: "var(--page-text)",
                            }}>
                              {item.value}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Footer */}
          {!loading && (
            <div style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 32,
              flexWrap: "wrap",
              gap: 12,
            }}>
              <button
                onClick={() => router.push("/")}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--page-text-muted)",
                  fontFamily: "var(--font-sans)",
                  fontSize: "13px",
                  cursor: "pointer",
                  padding: 0,
                  transition: "color 0.15s",
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--page-text)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--page-text-muted)"; }}
              >
                ← Back
              </button>

              {repos.length > 0 && (
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {confirmAll ? (
                    <>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--page-text-muted)" }}>
                        Clear everything?
                      </span>
                      <button
                        onClick={handleClearAll}
                        disabled={deletingAll}
                        style={{
                          padding: "7px 16px",
                          background: "#dc2626",
                          color: "#fff",
                          border: "none",
                          fontFamily: "var(--font-mono)",
                          fontSize: "12px",
                          fontWeight: 700,
                          cursor: "pointer",
                        }}
                      >
                        {deletingAll ? "Clearing…" : "Yes, clear all"}
                      </button>
                      <button
                        onClick={() => setConfirmAll(false)}
                        style={{
                          padding: "7px 16px",
                          background: "none",
                          color: "var(--page-text-muted)",
                          border: "1px solid var(--page-border)",
                          fontFamily: "var(--font-mono)",
                          fontSize: "12px",
                          cursor: "pointer",
                        }}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmAll(true)}
                      style={{
                        padding: "7px 16px",
                        background: "none",
                        color: "var(--page-text-muted)",
                        border: "1px solid var(--page-border)",
                        fontFamily: "var(--font-mono)",
                        fontSize: "12px",
                        cursor: "pointer",
                        transition: "border-color 0.15s, color 0.15s",
                        letterSpacing: "0.04em",
                      }}
                      onMouseEnter={(e) => {
                        const el = e.currentTarget as HTMLElement;
                        el.style.borderColor = "#dc2626";
                        el.style.color = "#dc2626";
                      }}
                      onMouseLeave={(e) => {
                        const el = e.currentTarget as HTMLElement;
                        el.style.borderColor = "var(--page-border)";
                        el.style.color = "var(--page-text-muted)";
                      }}
                    >
                      Clear all
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
