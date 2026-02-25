"use client";

import { ArchitectureDiagram } from "@/components/ArchitectureDiagram";
import { ModelSettings } from "@/components/ModelSettings";
import { STORAGE_COMPARISON } from "@/lib/eval-results";
import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";

export default function LandingPage() {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [isHowVisible, setIsHowVisible] = useState(false);
  const howSectionRef = useRef<HTMLElement>(null);
  const router = useRouter();

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

  return (
    <div style={styles.wrapper}>
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
            <span style={styles.badgeDot} />
            Client-side • Free
          </div>

          <h1 style={styles.title}>
            Turn any GitHub repo into a
            <span style={styles.gradient}> chat you can query</span>
          </h1>

          <p style={styles.subtitle}>
            RAG in your browser. Embeddings, storage, retrieval, all on-device
            with WebGPU. No server, no API keys.
          </p>

          <form onSubmit={handleSubmit} style={styles.form}>
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

          <a href="/evals" style={styles.evalsLink} className="evals-link">
            Evals
          </a>

          <div style={styles.features}>
            {[
              { label: "WebGPU Inference", desc: "GPU-accelerated embeddings" },
              { label: "AST Chunking", desc: "Tree-sitter code parsing" },
              { label: "Hybrid Search", desc: "Vector + keyword fusion" },
              {
                label: "Binary Quantization",
                desc: `${STORAGE_COMPARISON.compressionRatio}× smaller vectors. ${STORAGE_COMPARISON.exampleRepoChunks} chunks: ${STORAGE_COMPARISON.float32TotalKB.toFixed(0)}KB → ${STORAGE_COMPARISON.binaryTotalKB.toFixed(0)}KB. Same recall.`,
              },
            ].map((f) => (
              <div key={f.label} className="glass" style={styles.featureCard}>
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
  features: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
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
