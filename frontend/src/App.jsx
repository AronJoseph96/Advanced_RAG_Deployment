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
    --right-w: 320px;
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

// ─── Right Intelligence Panel ─────────────────────────────────────────────────
function RightPanel({ agentReady, history, needsUpload, onUploadSuccess }) {
  const [files, setFiles] = useState([]);
  const [uploadStatus, setUploadStatus] = useState(null);
  const [uploadMsg, setUploadMsg] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const fileInputRef = useRef();

  const handleUpload = async () => {
    if (!files.length) return;
    setUploadStatus("uploading"); setUploadMsg("");
    const csvFiles = files.filter(f => f.name.toLowerCase().endsWith(".csv"));
    const docFiles = files.filter(f => !f.name.toLowerCase().endsWith(".csv"));
    try {
      let results = [];
      if (docFiles.length) { const res = await uploadDocuments(docFiles); results.push(`${res.count || 0} nodes ingested`); }
      for (const csv of csvFiles) { const res = await uploadCSV(csv); results.push(res.message || "CSV loaded"); }
      setUploadStatus("done"); setUploadMsg(results.join(" · ")); setFiles([]);
      if (onUploadSuccess) onUploadSuccess();
    } catch (e) { setUploadStatus("error"); setUploadMsg(e.message); }
  };

  return (
    <aside style={{ position: "fixed", right: 0, top: 0, height: "100%", width: "var(--right-w)", background: "#0e0e10", borderLeft: "1px solid var(--border)", display: "flex", flexDirection: "column", padding: "24px 20px", zIndex: 40, overflowY: "auto" }}>
      <h2 style={{ fontSize: 24, fontWeight: 600, color: "var(--primary)", marginBottom: 28, marginTop: 56 }}>Intelligence</h2>

      {/* Knowledge Base Status */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: "var(--outline)", letterSpacing: "0.1em", textTransform: "uppercase" }}>Knowledge Base</span>
          <button onClick={() => setShowUpload(v => !v)} style={{ padding: "3px 10px", borderRadius: 6, border: "1px solid var(--border-strong)", color: "var(--on-surface-var)", fontSize: 11, transition: "all 0.15s", background: showUpload ? "var(--primary-faint)" : "none" }}
            onMouseEnter={e => { e.currentTarget.style.color = "var(--primary)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.25)"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "var(--on-surface-var)"; e.currentTarget.style.borderColor = "var(--border-strong)"; }}>
            {showUpload ? "Close" : "Upload"}
          </button>
        </div>

        {/* Status card */}
        <div className="glass" style={{ borderRadius: 12, padding: "12px 14px", borderLeft: needsUpload ? "2px solid var(--warn)" : "2px solid rgba(52,211,153,0.4)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="mso fill" style={{ fontSize: 16, color: needsUpload ? "var(--warn)" : "var(--success)" }}>{needsUpload ? "warning" : "database"}</span>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: needsUpload ? "var(--warn)" : "var(--primary)" }}>{needsUpload ? "Empty — upload needed" : agentReady ? "Agent Connected" : "Agent Offline"}</div>
              <div style={{ fontSize: 11, color: "var(--outline)" }}>{needsUpload ? "No documents indexed" : agentReady ? "Ready to query" : "Waking up… (30–60s on free tier)"}</div>
            </div>
          </div>
        </div>

        {/* Upload panel */}
        {showUpload && (
          <div style={{ marginTop: 10, animation: "fadeUp 0.15s ease" }}>
            <button onClick={() => fileInputRef.current.click()} style={{ width: "100%", border: "1.5px dashed var(--border-strong)", borderRadius: 10, padding: "14px 12px", fontSize: 12, color: "var(--on-surface-var)", background: "var(--surface2)", textAlign: "center", marginBottom: 8, transition: "all 0.15s" }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.25)"; e.currentTarget.style.color = "var(--primary)"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border-strong)"; e.currentTarget.style.color = "var(--on-surface-var)"; }}>
              <span className="mso" style={{ fontSize: 20, display: "block", marginBottom: 4 }}>upload_file</span>
              {files.length ? `${files.length} file${files.length > 1 ? "s" : ""} selected` : "Click to browse"}
            </button>
            <input ref={fileInputRef} type="file" accept=".pdf,.docx,.md,.txt,.csv" multiple style={{ display: "none" }}
              onChange={e => { setFiles(Array.from(e.target.files)); setUploadStatus(null); setUploadMsg(""); }} />

            {files.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
                {files.map((f, i) => {
                  const ext = f.name.split(".").pop().toUpperCase();
                  const fmt = SUPPORTED_FORMATS.find(s => s.ext === ext);
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, background: "rgba(255,255,255,0.04)", border: "1px solid var(--border)", borderRadius: 6, padding: "2px 6px", fontSize: 11 }}>
                      <span style={{ color: fmt?.color || "var(--outline)", fontWeight: 700, fontSize: 9 }}>{ext}</span>
                      <span style={{ color: "var(--on-surface-var)", maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name.replace(/\.[^.]+$/, "")}</span>
                      <button onClick={() => setFiles(prev => prev.filter((_, idx) => idx !== i))} style={{ color: "var(--outline)", fontSize: 13, lineHeight: 1 }}>×</button>
                    </div>
                  );
                })}
              </div>
            )}

            {files.length > 0 && uploadStatus !== "uploading" && (
              <button onClick={handleUpload} style={{ width: "100%", background: "var(--primary)", color: "#000", borderRadius: 8, padding: "8px", fontSize: 12, fontWeight: 600 }}>
                Upload {files.length > 1 ? `(${files.length} files)` : ""}
              </button>
            )}
            {uploadStatus === "uploading" && (
              <div style={{ textAlign: "center", fontSize: 12, color: "var(--on-surface-var)" }}>
                <span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>◌</span> Processing…
              </div>
            )}
            {uploadMsg && (
              <div style={{ marginTop: 6, fontSize: 11, padding: "6px 8px", borderLeft: `2px solid ${uploadStatus === "error" ? "var(--error)" : "var(--success)"}`, background: uploadStatus === "error" ? "rgba(248,113,113,0.06)" : "rgba(52,211,153,0.06)", color: uploadStatus === "error" ? "var(--error)" : "var(--success)", borderRadius: "0 4px 4px 0" }}>{uploadMsg}</div>
            )}

            {/* Supported formats */}
            <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 4 }}>
              {SUPPORTED_FORMATS.map(f => (
                <span key={f.ext} style={{ fontSize: 10, fontWeight: 700, color: f.color, padding: "2px 6px", border: `1px solid ${f.color}33`, borderRadius: 4 }}>{f.ext}</span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: "var(--border)", marginBottom: 24 }} />

      {/* Recent Sessions */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: "var(--outline)", letterSpacing: "0.1em", textTransform: "uppercase" }}>Recent Sessions</span>
          <span className="mso" style={{ fontSize: 16, color: "var(--outline)" }}>edit_note</span>
        </div>
        {history.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--outline)", padding: "8px 0" }}>No sessions yet</div>
        ) : (
          <ul style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {history.slice(0, 6).map(h => (
              <li key={h.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, cursor: "pointer", transition: "background 0.12s" }}
                onMouseEnter={e => e.currentTarget.style.background = "var(--primary-hover)"}
                onMouseLeave={e => e.currentTarget.style.background = "none"}>
                <span className="mso" style={{ fontSize: 16, color: "var(--outline)" }}>description</span>
                <div style={{ overflow: "hidden" }}>
                  <div style={{ fontSize: 12, color: "var(--on-surface)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }}>{h.title}</div>
                  <div style={{ fontSize: 10, color: "var(--outline)" }}>{new Date(h.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Bottom status card */}
      <div style={{ padding: "14px 16px", borderRadius: 16, background: "linear-gradient(135deg, rgba(255,255,255,0.06) 0%, transparent 100%)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--primary)" }}>Aeython Pro</div>
          <div style={{ fontSize: 11, color: "var(--outline)" }}>Hybrid RAG · Node Access</div>
        </div>
        <span className="mso fill" style={{ fontSize: 22, color: "var(--primary)" }}>verified</span>
      </div>
    </aside>
  );
}

// ─── Thinking Dots ────────────────────────────────────────────────────────────
function ThinkingDots() {
  return (
    <div style={{ display: "flex", gap: 5, alignItems: "center", padding: "8px 0" }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--primary-dim)", display: "inline-block", animation: `bounce 1.2s infinite ${i * 0.2}s` }} />
      ))}
    </div>
  );
}

// ─── Message Bubble ───────────────────────────────────────────────────────────
function MessageBubble({ msg }) {
  const isUser = msg.role === "user";
  const isError = msg.role === "error";
  const isThinking = msg.role === "thinking";

  return (
    <div style={{ display: "flex", gap: 14, padding: "14px 0", animation: "fadeUp 0.2s ease", alignItems: "flex-start" }}>
      {/* Avatar */}
      <div style={{ width: 32, height: 32, borderRadius: 8, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: isUser ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.08)", border: "1px solid var(--border-strong)", marginTop: 2 }}>
        <span className="mso" style={{ fontSize: 16, color: isUser ? "var(--on-surface-var)" : "var(--primary)" }}>{isUser ? "person" : "auto_awesome"}</span>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: isUser ? "var(--on-surface-var)" : "var(--primary)" }}>{isUser ? "You" : "Aeython"}</span>
          {msg.ts && <span style={{ fontSize: 11, color: "var(--outline)" }}>{msg.ts}</span>}
          {isError && <span style={{ fontSize: 10, background: "rgba(248,113,113,0.1)", color: "var(--error)", padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>ERROR</span>}
        </div>

        {isThinking ? <ThinkingDots /> : (
          isUser ? (
            <div className="glass" style={{ borderRadius: "4px 14px 14px 14px", padding: "10px 14px", fontSize: 14, color: "var(--on-surface)", lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-word", display: "inline-block", maxWidth: "80%" }}>
              {msg.content}
            </div>
          ) : (
            <div style={{ fontSize: 14, color: isError ? "var(--error)" : "var(--on-surface)", lineHeight: 1.8, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {msg.content}
              {msg.streaming && <span style={{ display: "inline-block", width: 2, height: 14, background: "var(--primary)", marginLeft: 3, verticalAlign: "middle", animation: "blink 0.8s infinite" }} />}
            </div>
          )
        )}
      </div>
    </div>
  );
}

// ─── Main Chat Area ───────────────────────────────────────────────────────────
function ChatArea({ agentReady, messages, setMessages, needsUpload, history }) {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState("stream");
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef(null);
  const textRef = useRef(null);
  const cancelRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

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
  const handleReset = async () => {
    if (!window.confirm("Clear conversation memory?")) return;
    if (cancelRef.current) cancelRef.current();
    try { await resetMemory(); } catch {}
    setMessages([]); setBusy(false);
  };

  const isEmpty = messages.length === 0;

  return (
    <main className="atmo" style={{ marginLeft: "var(--sidebar-w)", marginRight: "var(--right-w)", height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>

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
              placeholder={agentReady ? "What do you want to know?" : "Backend waking up on Render, please wait…"}
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
              <label title="Attach files" style={{ padding: 8, color: "var(--on-surface-var)", borderRadius: 8, transition: "all 0.15s", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                onMouseEnter={e => e.currentTarget.style.color = "var(--primary)"}
                onMouseLeave={e => e.currentTarget.style.color = "var(--on-surface-var)"}>
                <span className="mso" style={{ fontSize: 20 }}>attachment</span>
                <input type="file" accept=".pdf,.docx,.md,.txt,.csv" multiple style={{ display: "none" }}
                  onChange={async (e) => {
                    const picked = Array.from(e.target.files);
                    if (!picked.length) return;
                    e.target.value = "";
                    const csvFiles = picked.filter(f => f.name.toLowerCase().endsWith(".csv"));
                    const docFiles = picked.filter(f => !f.name.toLowerCase().endsWith(".csv"));
                    try {
                      let results = [];
                      if (docFiles.length) { const res = await uploadDocuments(docFiles); results.push(`${res.count || 0} nodes ingested`); }
                      for (const csv of csvFiles) { const res = await uploadCSV(csv); results.push(res.message || "CSV loaded"); }
                      alert("✓ " + results.join(" · "));
                    } catch (err) { alert("Upload failed: " + err.message); }
                  }} />
              </label>
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
  const [panelKey, setPanelKey] = useState(0); // incremented on flush to remount RightPanel and clear its local state

  useEffect(() => {
    const poll = async () => {
      try { const d = await checkHealth(); setAgentReady(!!d.agent_ready); }
      catch { setAgentReady(false); }
    };
    poll();
    const id = setInterval(poll, 30000);
    return () => clearInterval(id);
  }, []);

  const handleNewChat = async () => {
    if (messages.length > 0) {
      const first = messages.find(m => m.role === "user");
      if (first) setHistory(prev => [{ id: Date.now(), title: first.content.slice(0, 55) + (first.content.length > 55 ? "…" : ""), date: new Date() }, ...prev]);
    }
    try { await resetMemory(); } catch {}
    setMessages([]);
  };

  const handleFlushConfirm = async () => {
    setFlushPhase("flushing");
    try { await flushAll(); try { await resetMemory(); } catch {} setMessages([]); }
    catch (e) { console.error("Flush error:", e); }
    setFlushPhase("done");
    setNeedsUpload(true);
    setPanelKey(k => k + 1); // remounts RightPanel — clears stale uploadMsg/files/status
  };

  return (
    <>
      <style>{styles}</style>
      <LeftSidebar agentReady={agentReady} onNewChat={handleNewChat} onFlush={() => setFlushPhase("confirm")} />
      <ChatArea agentReady={agentReady} messages={messages} setMessages={setMessages} needsUpload={needsUpload} history={history} />
      <RightPanel key={panelKey} agentReady={agentReady} history={history} needsUpload={needsUpload} onUploadSuccess={() => setNeedsUpload(false)} />
      {flushPhase && <FlushOverlay phase={flushPhase} onConfirm={handleFlushConfirm} onCancel={() => setFlushPhase(null)} />}
    </>
  );
}
