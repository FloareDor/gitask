"use client";

import { ArchitectureDiagram } from "@/components/ArchitectureDiagram";
import { ModelSettings } from "@/components/ModelSettings";
import { STORAGE_COMPARISON } from "@/lib/eval-results";
import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";

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
      <div className="glass" style={{
        maxWidth: "380px",
        padding: "48px 40px",
        display: "flex",
        flexDirection: "column" as const,
        alignItems: "center",
        gap: "16px",
      }}>
        <span style={{ fontSize: "52px", lineHeight: 1 }}>💻</span>
        <h2 style={{ fontSize: "22px", fontWeight: 700, letterSpacing: "-0.02em" }}>
          WebGPU not supported
        </h2>
        <p style={{ fontSize: "14px", color: "var(--text-secondary)", lineHeight: 1.65 }}>
          This app needs WebGPU to run embeddings in your browser. Try{" "}
          <strong style={{ color: "var(--text-primary)" }}>Chrome or Edge on a desktop</strong>{" "}
          for the full experience.
        </p>
      </div>
    </div>
  );
}

export default function LandingPage() {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [isHowVisible, setIsHowVisible] = useState(false);
  const [gpuSupported, setGpuSupported] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const howSectionRef = useRef<HTMLElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (!("gpu" in navigator)) setGpuSupported(false);
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

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    // Parse GitHub URL
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

  if (!gpuSupported) return <NoWebGPUScreen />;

  const projectRepoUrl = "https://github.com/FloareDor/gitask";

  return (
    <div style={{ ...styles.wrapper, overflowX: "hidden" }}>
      {/* Settings - fixed top-right */}
      <div style={styles.settingsFixed}>
        <ModelSettings />
      </div>

      {/* Gradient orbs for visual flair */}
      <div style={styles.orbPurple} />
      <div style={styles.orbBlue} />

      <main style={styles.main}>
        <div className="fade-in" style={styles.hero}>
          <div style={styles.badge}>
            <span style={styles.badgeDot} className="pulse" />
            Client-side • Free
          </div>

          <h1 style={styles.title}>
            Turn any GitHub repo into a
            <span style={styles.gradient}> chat you can query</span>
          </h1>

          <p style={styles.subtitle}>
            Browser-native RAG. Embeddings, retrieval, and storage, all on-device
            via WebGPU. No server. API keys encrypted locally.
          </p>

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
              placeholder="Paste a GitHub URL (e.g. https://github.com/facebook/react)"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              style={styles.urlInput}
              id="repo-url-input"
            />
            <button type="submit" className="btn btn-primary" id="go-btn">
              Ask →
            </button>
          </form>

          {error && <p style={styles.error}>{error}</p>}

          <div style={styles.quickLinks}>
            <a href="/evals" style={styles.evalsLink} className="evals-link">
              Evals
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
              <span style={styles.starIcon}>Star</span>
              <img
                alt="GitHub stars"
                src="https://img.shields.io/github/stars/FloareDor/gitask?style=social"
                style={styles.starBadge}
              />
            </a>
          </div>

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
              { icon: "🔐", label: "Encrypted Key Vault", desc: "API keys stored locally, locked by passkey" },
            ].map((f, i) => (
              <div
                key={f.label}
                className="glass"
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
  orbPurple: {
    position: "absolute",
    top: "-20%",
    left: "-10%",
    width: "600px",
    height: "600px",
    borderRadius: "50%",
    background: "radial-gradient(circle, rgba(99,102,241,0.15) 0%, transparent 70%)",
    filter: "blur(60px)",
    pointerEvents: "none",
  },
  orbBlue: {
    position: "absolute",
    bottom: "-20%",
    right: "-10%",
    width: "500px",
    height: "500px",
    borderRadius: "50%",
    background: "radial-gradient(circle, rgba(59,130,246,0.12) 0%, transparent 70%)",
    filter: "blur(60px)",
    pointerEvents: "none",
  },
  main: {
    position: "relative",
    zIndex: 1,
    width: "100%",
    maxWidth: "800px",
    padding: "40px 24px",
    textAlign: "center",
  },
  hero: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "24px",
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 16px",
    borderRadius: "9999px",
    fontSize: "12px",
    fontWeight: 500,
    color: "var(--text-secondary)",
    background: "var(--bg-glass)",
    border: "1px solid var(--border)",
  },
  badgeDot: {
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    background: "var(--success)",
    display: "inline-block",
  },
  title: {
    fontSize: "clamp(2rem, 5vw, 3.2rem)",
    fontWeight: 700,
    lineHeight: 1.15,
    letterSpacing: "-0.02em",
  },
  gradient: {
    background: "linear-gradient(135deg, var(--accent), #a78bfa, #60a5fa)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
  subtitle: {
    fontSize: "16px",
    color: "var(--text-secondary)",
    lineHeight: 1.6,
    maxWidth: "560px",
  },
  form: {
    display: "flex",
    gap: "12px",
    width: "100%",
    maxWidth: "600px",
    marginTop: "8px",
  },
  urlInput: {
    flex: 1,
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
  },
  evalsLink: {
    fontSize: "13px",
    color: "var(--text-secondary)",
    textDecoration: "none",
    padding: "8px 16px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    transition: "all 0.2s ease",
    background: "var(--bg-glass)",
  },
  quickLinks: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    flexWrap: "wrap",
    justifyContent: "center",
  },
  starLink: {
    fontSize: "13px",
    color: "var(--text-primary)",
    textDecoration: "none",
    padding: "7px 12px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    transition: "all 0.2s ease",
    background: "var(--bg-glass)",
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
  },
  starIcon: {
    fontSize: "12px",
    fontWeight: 600,
    letterSpacing: "0.01em",
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
    marginTop: "32px",
  },
  featureCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "6px",
    padding: "20px 12px",
    textAlign: "center",
  },
  featureIcon: {
    fontSize: "22px",
    lineHeight: 1,
    marginBottom: "2px",
  },
  featureLabel: {
    fontSize: "13px",
    fontWeight: 600,
  },
  featureDesc: {
    fontSize: "12px",
    color: "var(--text-secondary)",
  },
  howSection: {
    width: "100%",
    marginTop: "128px",
    opacity: 0,
    transform: "translateY(28px)",
    transition: "opacity 0.55s ease, transform 0.55s ease",
  },
  howSectionVisible: {
    opacity: 1,
    transform: "translateY(0)",
  },
  howHeader: {
    textAlign: "center",
    marginBottom: "24px",
  },
  howTitle: {
    fontSize: "clamp(1.5rem, 2.4vw, 2rem)",
    fontWeight: 700,
    letterSpacing: "-0.02em",
  },
};
