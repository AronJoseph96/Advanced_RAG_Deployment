import { useState, useRef, useEffect } from "react";

const BASE = import.meta.env.VITE_API_URL || "https://advanced-rag-deployment.onrender.com";

// ─── API ──────────────────────────────────────────────────────────────────────
async function checkHealth() {
  const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(4000) });
  return r.json();
}
async function resetMemory() {
  const r = await fetch(`${BASE}/chat/memory`, { method: "DELETE" });
  return r.json();
}
async function flushAll() {
  const r = await fetch(`${BASE}/flush`, { method: "DELETE" });
  if (!r.ok) {
    const e = await r.json().catch(() => ({ detail: r.statusText }));
    throw new Error(e.detail || "Flush failed");
  }
  return r.json();
}
async function chatFull(query) {
  const r = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({ detail: r.statusText }));
    throw new Error(e.detail || "Chat request failed");
  }
  return r.json();
}
function chatStream(query, onToken, onDone, onError) {
  const url = `${BASE}/chat/stream?query=${encodeURIComponent(query)}`;
  let cancelled = false;
  fetch(url)
    .then(async (res) => {
      if (!res.ok) {
        const e = await res.json().catch(() => ({ detail: res.statusText }));
        onError(e.detail || "Stream failed");
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        if (cancelled) break;
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const token = line.slice(6);
          if (token === "[DONE]") { onDone(); return; }
          if (token.startsWith("[ERROR]")) { onError(token.slice(7)); return; }
          onToken(token.replace(/\\n/g, "\n"));
        }
      }
      onDone();
    })
    .catch((e) => { if (!cancelled) onError(e.message); });
  return () => { cancelled = true; };
}
async function uploadDocuments(files, chunkSize = 512, chunkOverlap = 64) {
  const form = new FormData();
  for (const f of files) form.append("files", f);
  form.append("chunk_size", chunkSize);
  form.append("chunk_overlap", chunkOverlap);
  const r = await fetch(`${BASE}/ingest/documents/upload`, { method: "POST", body: form });
  if (!r.ok) {
    const e = await r.json().catch(() => ({ detail: r.statusText }));
    throw new Error(e.detail || "Upload failed");
  }
  return r.json();
}
async function uploadCSV(file, tableName = "") {
  const form = new FormData();
  form.append("file", file);
  if (tableName) form.append("table_name", tableName);
  const r = await fetch(`${BASE}/ingest/csv`, { method: "POST", body: form });
  if (!r.ok) {
    const e = await r.json().catch(() => ({ detail: r.statusText }));
    throw new Error(e.detail || "CSV upload failed");
  }
  return r.json();
}

// ─── Constants ────────────────────────────────────────────────────────────────
function ts() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, "0")).join(":");
}

const SUGGESTIONS = [
  { icon: "lightbulb", label: "Generate Ideas" },
  { icon: "travel_explore", label: "Search Docs" },
  { icon: "bar_chart", label: "Analyze Data" },
  { icon: "question_mark", label: "Ask Anything" },
];

const SUPPORTED_FORMATS = [
  { ext: "PDF", color: "#f87171" },
  { ext: "DOCX", color: "#60a5fa" },
  { ext: "MD", color: "#34d399" },
  { ext: "TXT", color: "#9ca3af" },
  { ext: "CSV", color: "#a78bfa" },
];

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = `
  @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #09090b;
    --surface: #131315;
    --surface2: #1c1b1d;
    --surface3: #201f22;
    --surface-high: #2a2a2c;
    --border: rgba(255,255,255,0.07);
    --border-strong: rgba(255,255,255,0.12);
    --primary: #ffffff;
    --primary-dim: rgba(255,255,255,0.6);
    --primary-faint: rgba(255,255,255,0.08);
    --primary-hover: rgba(255,255,255,0.05);
    --on-surface: #e5e1e4;
    --on-surface-var: #c4c7c8;
    --outline: #8e9192;
    --success: #34d399;
    --warn: #fbbf24;
    --error: #f87171;
    --sans: 'Plus Jakarta Sans', system-ui, sans-serif;
    --sidebar-w: 64px;
  }
  html, body, #root { height: 100%; background: var(--bg); font-family: var(--sans); color: var(--on-surface); font-size: 14px; line-height: 1.6; overflow: hidden; }
  button { font-family: var(--sans); cursor: pointer; border: none; background: none; }
  textarea, input { font-family: var(--sans); }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }
  .mso {
    font-family: 'Material Symbols Outlined';
    font-weight: 300; font-style: normal;
    font-size: 20px; line-height: 1;
    letter-spacing: normal; text-transform: none;
    display: inline-block; white-space: nowrap;
    direction: ltr;
    -webkit-font-feature-settings: 'liga';
    font-feature-settings: 'liga';
    -webkit-font-smoothing: antialiased;
    font-variation-settings: 'FILL' 0, 'wght' 300, 'GRAD' 0, 'opsz' 24;
  }
  .mso.fill { font-variation-settings: 'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24; }
  .glass {
    background: rgba(255,255,255,0.03);
    backdrop-filter: blur(20px);
    border: 1px solid rgba(255,255,255,0.08);
  }
  .atmo {
    background: radial-gradient(circle at 50% -20%, rgba(255,255,255,0.06) 0%, transparent 60%);
  }

  @keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
  @keyframes bounce { 0%,80%,100%{transform:scale(0.5);opacity:0.3} 40%{transform:scale(1);opacity:1} }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes popIn { from { opacity: 0; transform: scale(0.96) translateY(6px); } to { opacity: 1; transform: none; } }
  @keyframes flushOverlayIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes flushRipple { 0% { transform: scale(0.3); opacity: 0.8; } 100% { transform: scale(4); opacity: 0; } }
  @keyframes flushParticleDrop {
    0%   { opacity: 1; transform: translateY(0) scale(1); }
    60%  { opacity: 0.7; }
    100% { opacity: 0; transform: translateY(80px) scale(0.3); }
  }
  @keyframes flushSpinReverse { to { transform: rotate(-360deg); } }
  @keyframes flushTextPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
  @keyframes flushSuccessScale { 0% { transform: scale(0.4); opacity: 0; } 60% { transform: scale(1.15); } 100% { transform: scale(1); opacity: 1; } }
  @keyframes nudge { 0%,100%{transform:rotate(0)} 25%{transform:rotate(-5deg)} 75%{transform:rotate(5deg)} }
`;

// ─── Flush Overlay ────────────────────────────────────────────────────────────
function FlushOverlay({ phase, onConfirm, onCancel }) {
  const pc = 16;
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 200,
      background: phase === "confirm" ? "rgba(0,0,0,0.7)" : "rgba(0,0,0,0.5)",
      backdropFilter: "blur(8px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      animation: "flushOverlayIn 0.2s ease",
    }}>
      {phase === "confirm" && (
        <div className="glass" style={{ borderRadius: 20, padding: "36px 40px 32px", maxWidth: 420, width: "90%", animation: "popIn 0.2s ease", textAlign: "center", boxShadow: "0 32px 80px rgba(0,0,0,0.6)" }}>
          <div style={{ width: 60, height: 60, borderRadius: "50%", background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.25)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
            <span className="mso" style={{ fontSize: 26, color: "var(--error)" }}>delete_sweep</span>
          </div>
          <div style={{ fontSize: 20, fontWeight: 600, color: "var(--primary)", marginBottom: 10 }}>Flush knowledge base?</div>
          <div style={{ fontSize: 13, color: "var(--on-surface-var)", lineHeight: 1.7, marginBottom: 28 }}>
            This permanently deletes <strong style={{ color: "var(--primary)" }}>all Pinecone vectors</strong> and <strong style={{ color: "var(--primary)" }}>all SQLite tables</strong>.
            <br /><br />
            <span style={{ color: "var(--error)" }}>You must re-upload files before querying again.</span>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={onCancel} style={{ flex: 1, padding: "10px", borderRadius: 10, border: "1px solid var(--border-strong)", color: "var(--on-surface-var)", fontSize: 13, fontWeight: 500 }}>Cancel</button>
            <button onClick={onConfirm} style={{ flex: 1, padding: "10px", borderRadius: 10, background: "var(--error)", color: "#fff", fontSize: 13, fontWeight: 600 }}>Yes, flush everything</button>
          </div>
        </div>
      )}

      {phase === "flushing" && (
        <div style={{ position: "relative", width: 260, height: 260, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {[0, 1, 2].map(i => (
            <div key={i} style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 80, height: 80, borderRadius: "50%", border: "1.5px solid rgba(248,113,113,0.4)", animation: `flushRipple 1.8s ease-out infinite ${i * 0.6}s`, pointerEvents: "none" }} />
          ))}
          {Array.from({ length: pc }).map((_, i) => {
            const angle = (i / pc) * 360;
            const r = 50 + (i % 3) * 18;
            const x = Math.cos((angle * Math.PI) / 180) * r;
            return (
              <div key={i} style={{ position: "absolute", top: "50%", left: "50%", width: 4 + (i % 3) * 2, height: 4 + (i % 3) * 2, borderRadius: "50%", background: `hsl(${i * 12}, 80%, 65%)`, transform: `translate(calc(-50% + ${x}px), -50%)`, animation: `flushParticleDrop 1.4s ease-in infinite ${(i / pc) * 0.8}s`, pointerEvents: "none" }} />
            );
          })}
          <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div style={{ width: 80, height: 80, borderRadius: "50%", background: "rgba(248,113,113,0.1)", border: "1.5px solid rgba(248,113,113,0.3)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 20 }}>
              <span className="mso fill" style={{ fontSize: 32, color: "var(--error)", animation: "flushSpinReverse 1s linear infinite", display: "inline-block" }}>refresh</span>
            </div>
            <div style={{ fontSize: 18, fontWeight: 600, color: "#fff", marginBottom: 6, animation: "flushTextPulse 1.2s ease-in-out infinite" }}>Flushing knowledge base…</div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>Deleting vectors · dropping tables</div>
          </div>
        </div>
      )}

      {phase === "done" && (
        <div className="glass" style={{ borderRadius: 20, padding: "36px 40px 32px", maxWidth: 420, width: "90%", animation: "popIn 0.3s ease", textAlign: "center", boxShadow: "0 32px 80px rgba(0,0,0,0.6)" }}>
          <div style={{ width: 60, height: 60, borderRadius: "50%", background: "rgba(52,211,153,0.1)", border: "1px solid rgba(52,211,153,0.3)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", animation: "flushSuccessScale 0.4s ease" }}>
            <span className="mso fill" style={{ fontSize: 26, color: "var(--success)" }}>check_circle</span>
          </div>
          <div style={{ fontSize: 20, fontWeight: 600, color: "var(--primary)", marginBottom: 12 }}>Knowledge base flushed</div>
          <div style={{ background: "rgba(251,191,36,0.07)", border: "1px solid rgba(251,191,36,0.2)", borderRadius: 12, padding: "12px 16px", marginBottom: 24, display: "flex", gap: 10, alignItems: "flex-start", textAlign: "left" }}>
            <span className="mso fill" style={{ fontSize: 20, color: "var(--warn)", flexShrink: 0, marginTop: 1 }}>warning</span>
            <div style={{ fontSize: 12, color: "var(--on-surface-var)", lineHeight: 1.6 }}>
              <strong style={{ color: "var(--warn)", display: "block", marginBottom: 2 }}>Upload files before querying</strong>
              The knowledge base is now empty. Use the attach button to upload documents or CSVs.
            </div>
          </div>
          <button onClick={onCancel} style={{ width: "100%", padding: "11px", borderRadius: 10, background: "var(--primary)", color: "#000", fontSize: 13, fontWeight: 600 }}>Got it, I'll upload now</button>
        </div>
      )}
    </div>
  );
}

// ─── Left Icon Sidebar ─────────────────────────────────────────────────────────
function LeftSidebar({ onNewChat, onFlush, agentReady }) {
  const navItems = [
    { icon: "chat_bubble", label: "Chat" },
    { icon: "explore", label: "Explore" },
    { icon: "grid_view", label: "Grid" },
    { icon: "trending_up", label: "Trends" },
  ];
  return (
    <aside style={{ position: "fixed", left: 0, top: 0, height: "100%", width: "var(--sidebar-w)", display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 24, paddingBottom: 24, borderRight: "1px solid var(--border)", background: "var(--bg)", zIndex: 50, justifyContent: "space-between" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 24 }}>
        {/* Logo */}
        <div style={{ marginBottom: 8 }}>
          <span className="mso" style={{ fontSize: 28, color: "var(--primary)" }}>all_inclusive</span>
        </div>
        {/* New chat */}
        <button onClick={onNewChat} title="New Chat" style={{ width: 36, height: 36, borderRadius: 10, background: "var(--primary-faint)", border: "1px solid var(--border-strong)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--primary)", boxShadow: "0 0 14px rgba(255,255,255,0.08)", transition: "transform 0.15s" }}
          onMouseEnter={e => e.currentTarget.style.transform = "scale(0.95)"}
          onMouseLeave={e => e.currentTarget.style.transform = "none"}>
          <span className="mso" style={{ fontSize: 20 }}>add</span>
        </button>
        {/* Nav */}
        {navItems.map(n => (
          <button key={n.icon} title={n.label} style={{ padding: 8, borderRadius: 8, color: "var(--on-surface-var)", transition: "all 0.15s" }}
            onMouseEnter={e => { e.currentTarget.style.color = "var(--primary)"; e.currentTarget.style.background = "var(--primary-hover)"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "var(--on-surface-var)"; e.currentTarget.style.background = "none"; }}>
            <span className="mso" style={{ fontSize: 22 }}>{n.icon}</span>
          </button>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
        {/* Flush */}
        <button onClick={onFlush} title="Flush knowledge base" style={{ padding: 8, borderRadius: 8, color: "var(--error)", opacity: 0.6, transition: "all 0.15s" }}
          onMouseEnter={e => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.background = "rgba(248,113,113,0.08)"; }}
          onMouseLeave={e => { e.currentTarget.style.opacity = "0.6"; e.currentTarget.style.background = "none"; }}>
          <span className="mso" style={{ fontSize: 22 }}>delete_sweep</span>
        </button>
        {/* Status dot */}
        <div title={agentReady ? "Agent connected" : "Agent offline"} style={{ width: 8, height: 8, borderRadius: "50%", background: agentReady ? "var(--success)" : "var(--outline)", boxShadow: agentReady ? "0 0 8px rgba(52,211,153,0.5)" : "none" }} />
        {/* Settings */}
        <button title="Settings" style={{ padding: 8, borderRadius: 8, color: "var(--on-surface-var)", transition: "all 0.15s" }}
          onMouseEnter={e => { e.currentTarget.style.color = "var(--primary)"; e.currentTarget.style.background = "var(--primary-hover)"; }}
          onMouseLeave={e => { e.currentTarget.style.color = "var(--on-surface-var)"; e.currentTarget.style.background = "none"; }}>
          <span className="mso" style={{ fontSize: 22 }}>settings</span>
        </button>
        {/* Avatar */}
        <div style={{ width: 32, height: 32, borderRadius: "50%", background: "var(--surface-high)", border: "1px solid var(--border-strong)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span className="mso" style={{ fontSize: 18, color: "var(--on-surface-var)" }}>account_circle</span>
        </div>
      </div>
    </aside>
  );
}

// ─── Attach Dropup Menu ───────────────────────────────────────────────────────
function AttachDropup({ onClose, onIngest, uploadToastRef }) {
  const docsRef = useRef();
  const csvRef = useRef();

  const handleFiles = async (files) => {
    onClose();
    await onIngest(Array.from(files));
  };

  return (
    <div style={{
      position: "absolute", bottom: "calc(100% + 10px)", left: 0,
      background: "var(--surface2)", border: "1px solid var(--border-strong)",
      borderRadius: 14, padding: "6px 0", width: 230, zIndex: 60,
      boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
      animation: "fadeUp 0.15s ease",
    }}>
      <div style={{ padding: "6px 16px 8px", fontSize: 10, letterSpacing: "0.1em", color: "var(--outline)", borderBottom: "1px solid var(--border)", marginBottom: 4, fontWeight: 700 }}>
        ATTACH FILES
      </div>

      {/* Documents option */}
      <button onClick={() => docsRef.current.click()} style={{
        width: "100%", background: "none", border: "none", display: "flex",
        alignItems: "center", gap: 12, padding: "10px 16px", cursor: "pointer",
        transition: "background 0.12s", textAlign: "left",
      }}
        onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}
        onMouseLeave={e => e.currentTarget.style.background = "none"}>
        <div style={{ width: 32, height: 32, borderRadius: 8, background: "rgba(255,255,255,0.06)", border: "1px solid var(--border-strong)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <span className="mso" style={{ fontSize: 16, color: "var(--primary)" }}>description</span>
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--primary)" }}>Documents</div>
          <div style={{ fontSize: 11, color: "var(--outline)" }}>PDF, DOCX, MD, TXT</div>
        </div>
      </button>
      <input ref={docsRef} type="file" accept=".pdf,.docx,.md,.txt" multiple style={{ display: "none" }}
        onChange={e => handleFiles(e.target.files)} />

      {/* CSV option */}
      <button onClick={() => csvRef.current.click()} style={{
        width: "100%", background: "none", border: "none", display: "flex",
        alignItems: "center", gap: 12, padding: "10px 16px", cursor: "pointer",
        transition: "background 0.12s", textAlign: "left",
      }}
        onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}
        onMouseLeave={e => e.currentTarget.style.background = "none"}>
        <div style={{ width: 32, height: 32, borderRadius: 8, background: "rgba(52,211,153,0.08)", border: "1px solid rgba(52,211,153,0.2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <span className="mso" style={{ fontSize: 16, color: "var(--success)" }}>table_chart</span>
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--primary)" }}>Structured CSV</div>
          <div style={{ fontSize: 11, color: "var(--outline)" }}>CSV → SQL analytics</div>
        </div>
      </button>
      <input ref={csvRef} type="file" accept=".csv" style={{ display: "none" }}
        onChange={e => handleFiles(e.target.files)} />
    </div>
  );
}

// ─── Upload Toast ─────────────────────────────────────────────────────────────
// ─── Global Toast System ──────────────────────────────────────────────────────
const TOAST_STYLES = {
  success: { bg: "rgba(52,211,153,0.12)",  border: "rgba(52,211,153,0.4)",  color: "var(--success)", icon: "check_circle" },
  error:   { bg: "rgba(248,113,113,0.12)", border: "rgba(248,113,113,0.4)", color: "var(--error)",   icon: "error" },
  info:    { bg: "rgba(255,255,255,0.07)", border: "rgba(255,255,255,0.15)",color: "var(--on-surface-var)", icon: "info" },
  warn:    { bg: "rgba(251,191,36,0.1)",   border: "rgba(251,191,36,0.35)", color: "var(--warn)",    icon: "warning" },
};

function Toast({ toast, onDismiss }) {
  if (!toast) return null;
  const s = TOAST_STYLES[toast.type] || TOAST_STYLES.info;

  return (
    <div style={{
      position: "fixed", bottom: 120, left: "50%", transform: "translateX(-50%)",
      background: s.bg, border: `1px solid ${s.border}`, color: s.color,
      borderRadius: 12, padding: toast.type === "confirm" ? "14px 18px" : "10px 18px",
      fontSize: 13, fontWeight: 500, zIndex: 200,
      animation: "fadeUp 0.2s ease",
      display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
      boxShadow: "0 8px 40px rgba(0,0,0,0.5)", minWidth: 260, maxWidth: 380,
      backdropFilter: "blur(12px)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, width: "100%" }}>
        <span className="mso fill" style={{ fontSize: 18, flexShrink: 0 }}>{s.icon}</span>
        <span style={{ flex: 1 }}>{toast.msg}</span>
        {toast.type !== "confirm" && (
          <button onClick={onDismiss} style={{ background: "none", border: "none", color: "inherit", opacity: 0.5, padding: 0, lineHeight: 1, cursor: "pointer", fontSize: 18 }}>
            <span className="mso" style={{ fontSize: 16 }}>close</span>
          </button>
        )}
      </div>
      {toast.type === "confirm" && (
        <div style={{ display: "flex", gap: 8, width: "100%" }}>
          <button onClick={toast.onCancel} style={{ flex: 1, padding: "7px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.15)", background: "none", color: "var(--on-surface-var)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
            Cancel
          </button>
          <button onClick={toast.onConfirm} style={{ flex: 1, padding: "7px", borderRadius: 8, border: "none", background: s.color, color: "#000", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            {toast.confirmLabel || "Confirm"}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Main Chat Area ───────────────────────────────────────────────────────────
function ChatArea({ agentReady, messages, setMessages, needsUpload, history }) {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState("stream");
  const [busy, setBusy] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploadToast, setUploadToast] = useState(null);
  const bottomRef = useRef(null);
  const textRef = useRef(null);
  const cancelRef = useRef(null);
  const attachRef = useRef(null);
  const mainRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // Close dropup on outside click
  useEffect(() => {
    if (!showAttach) return;
    const handler = (e) => { if (!attachRef.current?.contains(e.target)) setShowAttach(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showAttach]);

  const dismissToast = () => setUploadToast(null);

  const showToast = (msg, type = "success", extra = {}) => {
    setUploadToast({ msg, type, ...extra });
    if (type !== "confirm") setTimeout(() => setUploadToast(null), type === "info" ? 2500 : 3500);
  };

  const ingestFiles = async (files) => {
    const csvFiles = files.filter(f => f.name.toLowerCase().endsWith(".csv"));
    const docFiles = files.filter(f => !f.name.toLowerCase().endsWith(".csv"));
    showToast("Uploading & indexing…", "info");
    try {
      let results = [];
      if (docFiles.length) { const res = await uploadDocuments(docFiles); results.push(`${res.count || 0} nodes ingested`); }
      for (const csv of csvFiles) { const res = await uploadCSV(csv); results.push(res.message || "CSV loaded"); }
      showToast(results.join(" · "), "success");
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  const send = async () => {
    const q = input.trim();
    if (!q || busy || !agentReady) return;
    setInput("");
    if (textRef.current) textRef.current.style.height = "auto";
    setBusy(true);
    setMessages(prev => [...prev, { id: Date.now(), role: "user", content: q, ts: ts() }]);

    if (mode === "stream") {
      const agentId = Date.now() + 1;
      setMessages(prev => [...prev, { id: agentId, role: "agent", content: "", streaming: true, ts: ts() }]);
      let buffer = "";
      cancelRef.current = chatStream(q,
        (token) => {
          buffer += token;
          setMessages(prev => prev.map(m => m.id === agentId ? { ...m, content: buffer, streaming: true } : m));
        },
        () => {
          setMessages(prev => prev.map(m => m.id === agentId ? { ...m, streaming: false } : m));
          setBusy(false);
        },
        (err) => {
          setMessages(prev => prev.map(m => m.id === agentId ? { id: agentId, role: "error", content: err, ts: ts() } : m));
          setBusy(false);
        }
      );
    } else {
      const thinkId = Date.now() + 1;
      setMessages(prev => [...prev, { id: thinkId, role: "thinking", ts: ts() }]);
      try {
        const res = await chatFull(q);
        setMessages(prev => prev.map(m => m.id === thinkId ? { id: thinkId, role: "agent", content: res.response, ts: ts() } : m));
      } catch (e) {
        setMessages(prev => prev.map(m => m.id === thinkId ? { id: thinkId, role: "error", content: e.message, ts: ts() } : m));
      }
      setBusy(false);
    }
  };

  const handleKey = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };
  const handleInput = (e) => { setInput(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px"; };
  const handleReset = () => {
    showToast("Clear conversation memory?", "confirm", {
      confirmLabel: "Clear",
      onCancel: () => setUploadToast(null),
      onConfirm: async () => {
        setUploadToast(null);
        if (cancelRef.current) cancelRef.current();
        try { await resetMemory(); } catch {}
        setMessages([]); setBusy(false);
        showToast("Conversation cleared", "success");
      },
    });
  };

  // Drag and drop onto chat area
  const handleDragOver = (e) => { e.preventDefault(); setDragging(true); };
  const handleDragLeave = (e) => { if (!mainRef.current?.contains(e.relatedTarget)) setDragging(false); };
  const handleDrop = async (e) => {
    e.preventDefault(); setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) await ingestFiles(files);
  };

  const isEmpty = messages.length === 0;

  return (
    <main ref={mainRef} className="atmo"
      style={{ marginLeft: "var(--sidebar-w)", height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}
      onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>

      {/* Drag overlay */}
      {dragging && (
        <div style={{ position: "absolute", inset: 0, zIndex: 50, background: "rgba(255,255,255,0.03)", border: "2px dashed rgba(255,255,255,0.2)", borderRadius: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
          <div style={{ textAlign: "center", color: "var(--primary)" }}>
            <span className="mso" style={{ fontSize: 48, display: "block", marginBottom: 12, opacity: 0.6 }}>upload_file</span>
            <div style={{ fontSize: 18, fontWeight: 600 }}>Drop files to upload</div>
            <div style={{ fontSize: 13, color: "var(--outline)", marginTop: 4 }}>PDF, DOCX, MD, TXT, CSV</div>
          </div>
        </div>
      )}

      <Toast toast={uploadToast} onDismiss={dismissToast} />

      {/* Top bar */}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", height: 64, padding: "0 32px", flexShrink: 0, gap: 16 }}>
        {needsUpload && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--warn)", background: "rgba(251,191,36,0.07)", border: "1px solid rgba(251,191,36,0.2)", padding: "4px 12px", borderRadius: 20 }}>
            <span className="mso fill" style={{ fontSize: 14 }}>warning</span>
            Upload files before querying
          </div>
        )}
        {/* Mode toggles */}
        <div style={{ display: "flex", gap: 4 }}>
          {["stream", "full"].map(m => (
            <button key={m} onClick={() => setMode(m)} style={{ fontSize: 11, padding: "4px 12px", borderRadius: 20, border: `1px solid ${mode === m ? "rgba(255,255,255,0.25)" : "var(--border)"}`, color: mode === m ? "var(--primary)" : "var(--outline)", background: mode === m ? "var(--primary-faint)" : "transparent", fontWeight: mode === m ? 600 : 400, transition: "all 0.15s" }}>
              {m === "stream" ? "Streaming" : "Full"}
            </button>
          ))}
          <button onClick={handleReset} style={{ fontSize: 11, padding: "4px 12px", borderRadius: 20, border: "1px solid var(--border)", color: "var(--outline)", transition: "all 0.15s" }}
            onMouseEnter={e => { e.currentTarget.style.color = "var(--error)"; e.currentTarget.style.borderColor = "rgba(248,113,113,0.4)"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "var(--outline)"; e.currentTarget.style.borderColor = "var(--border)"; }}>
            Reset
          </button>
        </div>
        <span className="mso" style={{ fontSize: 22, color: "var(--on-surface-var)", cursor: "pointer" }}>notifications</span>
        <span className="mso" style={{ fontSize: 22, color: "var(--on-surface-var)", cursor: "pointer" }}>help_outline</span>
        <div style={{ width: 32, height: 32, borderRadius: "50%", background: "var(--surface-high)", border: "1px solid var(--border-strong)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span className="mso" style={{ fontSize: 18, color: "var(--on-surface-var)" }}>account_circle</span>
        </div>
      </header>

      {/* Messages / Empty state */}
      <div style={{ flex: 1, overflowY: "auto", padding: "0 40px 120px" }}>
        {isEmpty ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "60vh", gap: 32 }}>
            {/* Hero */}
            <div style={{ textAlign: "center" }}>
              <span className="mso" style={{ fontSize: 56, color: "var(--primary)", opacity: 0.7, display: "block", marginBottom: 20, fontVariationSettings: "'FILL' 0, 'wght' 200, 'GRAD' 0, 'opsz' 24" }}>all_inclusive</span>
              <h1 style={{ fontSize: 40, fontWeight: 600, color: "var(--primary)", letterSpacing: "-0.02em", marginBottom: 8 }}>How can I help you today?</h1>
              <p style={{ fontSize: 15, color: "var(--outline)" }}>Intelligence at the speed of thought.</p>
            </div>

            {/* AI welcome card */}
            <div style={{ maxWidth: 600, width: "100%" }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 24 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: "rgba(255,255,255,0.08)", border: "1px solid var(--border-strong)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <span className="mso" style={{ fontSize: 16, color: "var(--primary)" }}>auto_awesome</span>
                </div>
                <div className="glass" style={{ borderRadius: "4px 14px 14px 14px", padding: "14px 18px" }}>
                  <p style={{ fontSize: 14, color: "var(--on-surface)", lineHeight: 1.7 }}>
                    Welcome to Aeython. Upload your documents or CSV files, then ask anything about your knowledge base. I'll search, synthesize, and surface answers for you.
                  </p>
                </div>
              </div>

              {/* Suggestion grid */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
                {SUGGESTIONS.map((s, i) => (
                  <button key={i} onClick={() => { setInput(s.label); textRef.current?.focus(); }}
                    className="glass"
                    style={{ borderRadius: 12, padding: "14px 10px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, transition: "all 0.15s", cursor: "pointer" }}
                    onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.15)"; }}
                    onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.03)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; }}>
                    <span className="mso" style={{ fontSize: 22, color: "rgba(255,255,255,0.5)", transition: "color 0.15s" }}>{s.icon}</span>
                    <span style={{ fontSize: 10, fontWeight: 600, color: "var(--on-surface-var)", textTransform: "uppercase", letterSpacing: "0.06em", textAlign: "center" }}>{s.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ maxWidth: 720, margin: "0 auto", paddingTop: 16 }}>
            {messages.map(msg => <MessageBubble key={msg.id} msg={msg} />)}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Floating command input */}
      <div style={{ position: "absolute", bottom: 24, left: 32, right: 32, display: "flex", justifyContent: "center" }}>
        <div className="glass" style={{ width: "100%", maxWidth: 720, borderRadius: 18, padding: "6px 6px 6px 6px", boxShadow: "0 8px 40px rgba(0,0,0,0.5)" }}>
          <div style={{ display: "flex", alignItems: "center", padding: "6px 12px" }}>
            <textarea ref={textRef} value={input} onChange={handleInput} onKeyDown={handleKey}
              disabled={busy || !agentReady}
              placeholder={agentReady ? "What do you want to know?" : "Waiting for agent…"}
              rows={1}
              style={{ flex: 1, background: "transparent", border: "none", outline: "none", resize: "none", fontSize: 14, color: "var(--primary)", lineHeight: 1.6, minHeight: 24, maxHeight: 160, overflowY: "auto", caretColor: "var(--primary)" }}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 6px 4px" }}>
            {/* Left: mode badge */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 6px" }}>
              <button style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", borderRadius: 8, background: "rgba(255,255,255,0.05)", border: "1px solid var(--border)", color: "var(--on-surface-var)", fontSize: 12, transition: "all 0.15s" }}>
                <span className="mso" style={{ fontSize: 14 }}>rocket_launch</span>
                <span>{mode === "stream" ? "Stream" : "Full"}</span>
                <span className="mso" style={{ fontSize: 14 }}>expand_more</span>
              </button>
            </div>
            {/* Right: action buttons */}
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              {/* Attach dropup */}
              <div ref={attachRef} style={{ position: "relative" }}>
                <button title="Attach files" onClick={() => setShowAttach(v => !v)}
                  style={{ padding: 8, color: showAttach ? "var(--primary)" : "var(--on-surface-var)", borderRadius: 8, transition: "all 0.15s", display: "flex", alignItems: "center", justifyContent: "center", background: showAttach ? "var(--primary-faint)" : "none" }}
                  onMouseEnter={e => { if (!showAttach) e.currentTarget.style.color = "var(--primary)"; }}
                  onMouseLeave={e => { if (!showAttach) e.currentTarget.style.color = "var(--on-surface-var)"; }}>
                  <span className="mso" style={{ fontSize: 20, transition: "transform 0.2s", transform: showAttach ? "rotate(45deg)" : "none" }}>attachment</span>
                </button>
                {showAttach && (
                  <AttachDropup
                    onClose={() => setShowAttach(false)}
                    onIngest={ingestFiles}
                  />
                )}
              </div>
              {/* Send button */}
              <button onClick={send} disabled={busy || !agentReady || !input.trim()}
                style={{ width: 36, height: 36, borderRadius: 10, background: (busy || !input.trim()) ? "rgba(255,255,255,0.06)" : "var(--primary)", border: "none", display: "flex", alignItems: "center", justifyContent: "center", color: (busy || !input.trim()) ? "var(--outline)" : "#000", transition: "all 0.15s", cursor: busy ? "not-allowed" : "pointer" }}
                onMouseEnter={e => { if (!busy && input.trim()) e.currentTarget.style.opacity = "0.88"; }}
                onMouseLeave={e => { e.currentTarget.style.opacity = "1"; }}>
                {busy
                  ? <span className="mso" style={{ fontSize: 18, animation: "spin 1s linear infinite", display: "inline-block" }}>refresh</span>
                  : <span className="mso" style={{ fontSize: 18 }}>keyboard_command_key</span>
                }
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

// ─── App Root ─────────────────────────────────────────────────────────────────
export default function App() {
  const [agentReady, setAgentReady] = useState(false);
  const [messages, setMessages] = useState([]);
  const [history, setHistory] = useState([]);
  const [flushPhase, setFlushPhase] = useState(null);
  const [needsUpload, setNeedsUpload] = useState(false);
  const [appToast, setAppToast] = useState(null);
  const prevAgentReady = useRef(null);

  const showAppToast = (msg, type = "info", extra = {}) => {
    setAppToast({ msg, type, ...extra });
    if (type !== "confirm") setTimeout(() => setAppToast(null), type === "error" ? 4000 : 3000);
  };

  useEffect(() => {
    const poll = async () => {
      try {
        const d = await checkHealth();
        const ready = !!d.agent_ready;
        setAgentReady(ready);
        // Notify on status change (skip very first poll)
        if (prevAgentReady.current !== null && prevAgentReady.current !== ready) {
          showAppToast(
            ready ? "Agent is online and ready" : "Agent went offline",
            ready ? "success" : "warn"
          );
        }
        prevAgentReady.current = ready;
      } catch {
        setAgentReady(false);
        if (prevAgentReady.current !== false) {
          showAppToast("Cannot reach backend", "error");
        }
        prevAgentReady.current = false;
      }
    };
    poll();
    const id = setInterval(poll, 30000);
    return () => clearInterval(id);
  }, []);

  const handleNewChat = async () => {
    if (messages.length === 0) return;
    showAppToast("Start a new chat?", "confirm", {
      confirmLabel: "New Chat",
      onCancel: () => setAppToast(null),
      onConfirm: async () => {
        setAppToast(null);
        const first = messages.find(m => m.role === "user");
        if (first) setHistory(prev => [{ id: Date.now(), title: first.content.slice(0, 55) + (first.content.length > 55 ? "…" : ""), date: new Date() }, ...prev]);
        try { await resetMemory(); } catch {}
        setMessages([]);
        showAppToast("New chat started", "success");
      },
    });
  };

  const handleFlushConfirm = async () => {
    setFlushPhase("flushing");
    try {
      await flushAll();
      try { await resetMemory(); } catch {}
      setMessages([]);
      setFlushPhase("done");
      setNeedsUpload(true);
    } catch (e) {
      console.error("Flush error:", e);
      setFlushPhase(null);
      showAppToast("Flush failed: " + e.message, "error");
    }
  };

  return (
    <>
      <style>{styles}</style>
      <LeftSidebar agentReady={agentReady} onNewChat={handleNewChat} onFlush={() => setFlushPhase("confirm")} />
      <ChatArea agentReady={agentReady} messages={messages} setMessages={setMessages} needsUpload={needsUpload} history={history} />
      {flushPhase && <FlushOverlay phase={flushPhase} onConfirm={handleFlushConfirm} onCancel={() => setFlushPhase(null)} />}
      <Toast toast={appToast} onDismiss={() => setAppToast(null)} />
    </>
  );
}