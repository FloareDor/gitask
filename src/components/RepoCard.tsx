"use client";

interface RepoCardProps {
  owner: string;
  repo: string;
  description?: string;
  onClick: (owner: string, repo: string) => void;
}

export function RepoCard({ owner, repo, description, onClick }: RepoCardProps) {
  return (
    <button
      className="repo-card"
      onClick={() => onClick(owner, repo)}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: "10px",
        padding: "20px 24px",
        background: "#fff",
        border: "2px solid #0a0a0a",
        borderRadius: 0,
        boxShadow: "4px 4px 0 #0a0a0a",
        cursor: "pointer",
        textAlign: "left",
        width: "100%",
        transition: "transform 0.1s ease, box-shadow 0.1s ease",
        fontFamily: "inherit",
      }}
      onMouseEnter={e => {
        const el = e.currentTarget;
        el.style.transform = "translate(-2px, -2px)";
        el.style.boxShadow = "6px 6px 0 #0a0a0a";
      }}
      onMouseLeave={e => {
        const el = e.currentTarget;
        el.style.transform = "translate(0, 0)";
        el.style.boxShadow = "4px 4px 0 #0a0a0a";
      }}
    >
      <span style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.85rem",
        fontWeight: 600,
        color: "#0a0a0a",
        letterSpacing: "-0.01em",
      }}>
        {owner}/<span style={{ color: "var(--accent)" }}>{repo}</span>
      </span>
      {description && (
        <span style={{
          fontSize: "0.8rem",
          color: "var(--text-secondary)",
          lineHeight: 1.4,
        }}>
          {description}
        </span>
      )}
      <span style={{
        fontSize: "0.75rem",
        fontWeight: 700,
        color: "var(--accent)",
        marginTop: "auto",
      }}>
        Explore →
      </span>
    </button>
  );
}
