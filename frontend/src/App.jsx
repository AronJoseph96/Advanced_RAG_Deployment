import { useState, useRef, useEffect, useCallback } from "react";

const BASE = "http://localhost:8000";

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

const SUGGESTIONS = [
  { icon: "analytics", title: "Synthesize Data", desc: "Summarize structured CSV data — counts, averages, rankings." },
  { icon: "travel_explore", title: "Search Documents", desc: "Find information from uploaded PDFs, DOCX, or Markdown files." },
  { icon: "query_stats", title: "Hybrid Query", desc: "Ask questions that span both documents and structured tables." },
];

function ts() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

const SUPPORTED_FORMATS = [
  { ext: "PDF", color: "#dc2626", bg: "rgba(220,38,38,0.08)" },
  { ext: "DOCX", color: "#2563eb", bg: "rgba(37,99,235,0.08)" },
  { ext: "MD", color: "#059669", bg: "rgba(5,150,105,0.08)" },
  { ext: "TXT", color: "#6b6860", bg: "rgba(107,104,96,0.1)" },
  { ext: "CSV", color: "#7c3aed", bg: "rgba(124,58,237,0.08)" },
];

const styles = `
  @import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;1,400&family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #f5f4f1;
    --surface: #ffffff;
    --surface2: #f0eeea;
    --border: rgba(0,0,0,0.08);
    --border-strong: rgba(0,0,0,0.14);
    --accent: #5b3af5;
    --accent-light: rgba(91,58,245,0.08);
    --accent-mid: rgba(91,58,245,0.18);
    --text: #1a1918;
    --text-muted: #6b6860;
    --text-dim: #9e9a94;
    --success: #16a34a;
    --warn: #d97706;
    --error: #dc2626;
    --flush: #dc2626;
    --flush-light: rgba(220,38,38,0.07);
    --flush-mid: rgba(220,38,38,0.18);
    --sidebar: 272px;
    --serif: 'Instrument Serif', Georgia, serif;
    --sans: 'DM Sans', system-ui, sans-serif;
  }
  html, body, #root { height: 100%; background: var(--bg); font-family: var(--sans); color: var(--text); font-size: 14px; line-height: 1.6; overflow: hidden; }
  button { font-family: var(--sans); cursor: pointer; }
  textarea { font-family: var(--sans); }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 4px; }
  .mso { font-family: 'Material Symbols Outlined'; font-weight: 300; font-style: normal; font-size: 20px; line-height: 1; letter-spacing: normal; text-transform: none; display: inline-block; white-space: nowrap; direction: ltr; -webkit-font-feature-settings: 'liga'; font-feature-settings: 'liga'; -webkit-font-smoothing: antialiased; font-variation-settings: 'FILL' 0, 'wght' 300, 'GRAD' 0, 'opsz' 24; }
  .mso.fill { font-variation-settings: 'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24; }

  @keyframes fadeUp { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
  @keyframes bounce { 0%,80%,100%{transform:scale(0.5);opacity:0.3} 40%{transform:scale(1);opacity:1} }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes popIn { from { opacity: 0; transform: scale(0.95) translateY(4px); } to { opacity: 1; transform: none; } }

  /* Flush animations */
  @keyframes flushOverlayIn {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  @keyframes flushParticleDrop {
    0%   { transform: translateY(-20px) scale(1);   opacity: 1; }
    60%  { transform: translateY(60px)  scale(0.8); opacity: 0.7; }
    100% { transform: translateY(100px) scale(0.3); opacity: 0; }
  }
  @keyframes flushRipple {
    0%   { transform: scale(0.3); opacity: 0.8; }
    100% { transform: scale(4);   opacity: 0; }
  }
  @keyframes flushTextPulse {
    0%,100% { opacity: 1; }
    50%     { opacity: 0.4; }
  }
  @keyframes flushSpinReverse {
    to { transform: rotate(-360deg); }
  }
  @keyframes flushSuccessScale {
    0%   { transform: scale(0.4); opacity: 0; }
    60%  { transform: scale(1.15); opacity: 1; }
    100% { transform: scale(1); opacity: 1; }
  }
  @keyframes flushWaveDrop {
    0%   { transform: scaleX(1.2) translateY(-40px); opacity: 0; }
    30%  { opacity: 1; }
    100% { transform: scaleX(1) translateY(120%); opacity: 0.3; }
  }
  @keyframes nudge {
    0%,100% { transform: rotate(0deg); }
    25%     { transform: rotate(-4deg); }
    75%     { transform: rotate(4deg); }
  }
  @keyframes remindBounce {
    0%   { transform: translateY(20px); opacity: 0; }
    60%  { transform: translateY(-4px); }
    100% { transform: translateY(0);    opacity: 1; }
  }
`;

// ─── Flush Overlay ────────────────────────────────────────────────────────────
function FlushOverlay({ phase, onConfirm, onCancel }) {
  // phase: "confirm" | "flushing" | "done"
  const particleCount = 18;

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: phase === "confirm"
        ? "rgba(0,0,0,0.45)"
        : "rgba(220,38,38,0.06)",
      backdropFilter: "blur(6px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      animation: "flushOverlayIn 0.2s ease",
    }}>

      {/* ── Confirm phase ──────────────────────────────────────────────────── */}
      {phase === "confirm" && (
        <div style={{
          background: "var(--surface)",
          border: "1px solid var(--border-strong)",
          borderRadius: 20,
          padding: "36px 40px 32px",
          maxWidth: 420, width: "90%",
          boxShadow: "0 24px 60px rgba(0,0,0,0.18)",
          animation: "popIn 0.2s ease",
          textAlign: "center",
        }}>
          <div style={{
            width: 64, height: 64, borderRadius: "50%",
            background: "var(--flush-light)",
            border: "1.5px solid rgba(220,38,38,0.25)",
            display: "flex", alignItems: "center", justifyContent: "center",
            margin: "0 auto 20px",
          }}>
            <span className="mso" style={{ fontSize: 28, color: "var(--flush)" }}>delete_sweep</span>
          </div>

          <div style={{ fontFamily: "var(--serif)", fontSize: 22, fontStyle: "italic", marginBottom: 10 }}>
            Flush knowledge base?
          </div>
          <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.7, marginBottom: 28 }}>
            This will permanently delete <strong style={{ color: "var(--text)" }}>all vectors from Pinecone</strong> and{" "}
            <strong style={{ color: "var(--text)" }}>all tables from SQLite</strong>. Old document data will be gone.
            <br /><br />
            <span style={{ color: "var(--flush)", fontWeight: 500 }}>You must upload new files before querying again.</span>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={onCancel} style={{
              flex: 1, padding: "10px", borderRadius: 10,
              border: "1px solid var(--border-strong)",
              background: "transparent", color: "var(--text-muted)",
              fontSize: 13, fontWeight: 500,
            }}>Cancel</button>
            <button onClick={onConfirm} style={{
              flex: 1, padding: "10px", borderRadius: 10,
              border: "none",
              background: "var(--flush)", color: "#fff",
              fontSize: 13, fontWeight: 600,
              boxShadow: "0 4px 14px rgba(220,38,38,0.3)",
              transition: "transform 0.1s",
            }}
              onMouseEnter={e => e.currentTarget.style.transform = "scale(1.02)"}
              onMouseLeave={e => e.currentTarget.style.transform = "none"}
            >
              Yes, flush everything
            </button>
          </div>
        </div>
      )}

      {phase === "flushing" && (
        <div style={{ textAlign: "center", position: "relative", width: 260, height: 260, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {/* Ripple rings */}
          {[0, 1, 2].map(i => (
            <div key={i} style={{
              position: "absolute",
              top: "50%", left: "50%",
              transform: "translate(-50%, -50%)",
              width: 80, height: 80,
              borderRadius: "50%",
              border: "2px solid rgba(220,38,38,0.4)",
              animation: `flushRipple 1.8s ease-out infinite ${i * 0.6}s`,
              pointerEvents: "none",
            }} />
          ))}

          {/* Falling particles */}
          {Array.from({ length: particleCount }).map((_, i) => {
            const angle = (i / particleCount) * 360;
            const radius = 50 + (i % 3) * 20;
            const x = Math.cos((angle * Math.PI) / 180) * radius;
            const delay = (i / particleCount) * 0.8;
            const size = 4 + (i % 3) * 2;
            return (
              <div key={i} style={{
                position: "absolute",
                top: "50%", left: "50%",
                width: size, height: size,
                borderRadius: "50%",
                background: `hsl(${i * 10}, 80%, ${55 + (i % 3) * 10}%)`,
                transform: `translate(calc(-50% + ${x}px), -50%)`,
                animation: `flushParticleDrop 1.4s ease-in infinite ${delay}s`,
                pointerEvents: "none",
              }} />
            );
          })}

          {/* Central icon + text */}
          <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div style={{
              width: 80, height: 80, borderRadius: "50%",
              background: "rgba(220,38,38,0.1)",
              border: "2px solid rgba(220,38,38,0.3)",
              display: "flex", alignItems: "center", justifyContent: "center",
              marginBottom: 20,
            }}>
              <span className="mso fill" style={{
                fontSize: 34, color: "var(--flush)",
                animation: "flushSpinReverse 1s linear infinite",
                display: "inline-block",
              }}>refresh</span>
            </div>
            <div style={{
              fontFamily: "var(--serif)", fontSize: 20, fontStyle: "italic",
              color: "#fff", marginBottom: 6,
              animation: "flushTextPulse 1.2s ease-in-out infinite",
              textShadow: "0 2px 8px rgba(0,0,0,0.5)",
            }}>
              Flushing knowledge base…
            </div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)" }}>
              Deleting vectors · dropping tables
            </div>
          </div>
        </div>
      )}

      {/* ── Done phase ─────────────────────────────────────────────────────── */}
      {phase === "done" && (
        <div style={{
          background: "var(--surface)",
          border: "1px solid var(--border-strong)",
          borderRadius: 20,
          padding: "36px 40px 32px",
          maxWidth: 420, width: "90%",
          boxShadow: "0 24px 60px rgba(0,0,0,0.18)",
          animation: "popIn 0.3s ease",
          textAlign: "center",
        }}>
          {/* Success checkmark */}
          <div style={{
            width: 64, height: 64, borderRadius: "50%",
            background: "rgba(22,163,74,0.1)",
            border: "1.5px solid rgba(22,163,74,0.3)",
            display: "flex", alignItems: "center", justifyContent: "center",
            margin: "0 auto 20px",
            animation: "flushSuccessScale 0.4s ease",
          }}>
            <span className="mso fill" style={{ fontSize: 28, color: "var(--success)" }}>check_circle</span>
          </div>

          <div style={{ fontFamily: "var(--serif)", fontSize: 22, fontStyle: "italic", marginBottom: 12 }}>
            Knowledge base flushed
          </div>

          {/* Reminder banner */}
          <div style={{
            background: "rgba(217,119,6,0.08)",
            border: "1px solid rgba(217,119,6,0.25)",
            borderRadius: 12,
            padding: "14px 16px",
            marginBottom: 24,
            display: "flex", gap: 12, alignItems: "flex-start",
            textAlign: "left",
            animation: "remindBounce 0.5s ease 0.15s both",
          }}>
            <span className="mso fill" style={{ fontSize: 22, color: "var(--warn)", flexShrink: 0, marginTop: 1 }}>warning</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--warn)", marginBottom: 3 }}>
                Upload new files before querying
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
                The knowledge base is now empty. Use the <strong>Attach</strong> button or sidebar to upload your new documents or CSV before asking any questions.
              </div>
            </div>
          </div>

          <button onClick={onCancel} style={{
            width: "100%", padding: "11px",
            borderRadius: 10, border: "none",
            background: "var(--text)", color: "#fff",
            fontSize: 13, fontWeight: 600,
          }}>
            Got it, I'll upload now
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function Sidebar({ agentReady, history, onNewChat, onFlush, needsUpload, onUploadSuccess }) {
  const [files, setFiles] = useState([]);
  const [status, setStatus] = useState(null);
  const [msg, setMsg] = useState("");
  const [showAttach, setShowAttach] = useState(false);
  const fileInputRef = useRef();
  const attachRef = useRef();

  useEffect(() => {
    function handler(e) {
      if (attachRef.current && !attachRef.current.contains(e.target)) setShowAttach(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleUpload = async () => {
    if (!files.length) return;
    setStatus("uploading"); setMsg("");
    const csvFiles = files.filter(f => f.name.toLowerCase().endsWith(".csv"));
    const docFiles = files.filter(f => !f.name.toLowerCase().endsWith(".csv"));
    try {
      let results = [];
      if (docFiles.length) {
        const res = await uploadDocuments(docFiles);
        results.push(`${res.count || 0} nodes ingested`);
      }
      for (const csv of csvFiles) {
        const res = await uploadCSV(csv);
        results.push(res.message || `CSV loaded`);
      }
      setStatus("done");
      setMsg(results.join(" · "));
      setFiles([]);
      if (onUploadSuccess) onUploadSuccess(); // clears needsUpload banner in App
    } catch (e) { setStatus("error"); setMsg(e.message); }
  };

  const todayH = history.filter(h => new Date(h.date).toDateString() === new Date().toDateString());
  const olderH = history.filter(h => new Date(h.date).toDateString() !== new Date().toDateString());

  return (
    <aside style={{ width: "var(--sidebar)", flexShrink: 0, background: "var(--surface)", borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
      {/* Logo */}
      <div style={{ padding: "20px 20px 16px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 36, height: 36, background: "var(--accent)", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span className="mso fill" style={{ fontSize: 18, color: "#fff" }}>bolt</span>
          </div>
          <div>
            <div style={{ fontFamily: "var(--serif)", fontSize: 17, fontStyle: "italic", color: "var(--text)", lineHeight: 1.2 }}>AdvRAG</div>
            <div style={{ fontSize: 10, color: "var(--text-dim)", letterSpacing: "0.06em", textTransform: "uppercase" }}>Intelligence Engine</div>
          </div>
        </div>
      </div>

      {/* New Chat + Attach */}
      <div style={{ padding: "14px 16px 10px", position: "relative" }} ref={attachRef}>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onNewChat} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, background: "var(--text)", color: "#fff", border: "none", borderRadius: 10, padding: "9px 14px", fontSize: 13, fontWeight: 500 }}>
            <span className="mso" style={{ fontSize: 17, color: "#fff" }}>add</span> New chat
          </button>
          <button onClick={() => setShowAttach(v => !v)} title="Attach files" style={{ width: 38, height: 38, display: "flex", alignItems: "center", justifyContent: "center", background: needsUpload ? "rgba(217,119,6,0.1)" : "var(--surface2)", border: `1px solid ${needsUpload ? "rgba(217,119,6,0.4)" : "var(--border)"}`, borderRadius: 10, flexShrink: 0, color: needsUpload ? "var(--warn)" : "var(--text-muted)", animation: needsUpload ? "nudge 1s ease-in-out infinite" : "none" }}>
            <span className="mso" style={{ fontSize: 18 }}>{needsUpload ? "upload_file" : "attach_file"}</span>
          </button>
        </div>

        {/* Upload needs reminder badge */}
        {needsUpload && (
          <div style={{ marginTop: 8, padding: "7px 10px", background: "rgba(217,119,6,0.08)", border: "1px solid rgba(217,119,6,0.25)", borderRadius: 8, fontSize: 11, color: "var(--warn)", display: "flex", gap: 6, alignItems: "center" }}>
            <span className="mso fill" style={{ fontSize: 14, flexShrink: 0 }}>warning</span>
            Upload files before querying
          </div>
        )}

        {showAttach && (
          <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 16, right: 16, background: "var(--surface)", border: "1px solid var(--border-strong)", borderRadius: 14, boxShadow: "0 8px 28px rgba(0,0,0,0.12)", zIndex: 100, padding: 16, animation: "popIn 0.15s ease" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 12 }}>Attach Files</div>
            <button onClick={() => fileInputRef.current.click()} style={{ width: "100%", border: "1.5px dashed var(--border-strong)", borderRadius: 10, padding: "16px 12px", fontSize: 13, color: "var(--text-muted)", background: "var(--surface2)", textAlign: "center", lineHeight: 1.5 }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.color = "var(--accent)"; e.currentTarget.style.background = "var(--accent-light)"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border-strong)"; e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--surface2)"; }}>
              <span className="mso" style={{ fontSize: 22, display: "block", marginBottom: 4 }}>upload_file</span>
              {files.length ? `${files.length} file${files.length > 1 ? "s" : ""} selected` : "Click to browse"}
            </button>
            <input ref={fileInputRef} type="file" accept=".pdf,.docx,.md,.txt,.csv" multiple style={{ display: "none" }}
              onChange={e => { setFiles(Array.from(e.target.files)); setStatus(null); setMsg(""); }} />

            {files.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8 }}>
                {files.map((f, i) => {
                  const ext = f.name.split(".").pop().toUpperCase();
                  const fmt = SUPPORTED_FORMATS.find(s => s.ext === ext);
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, background: fmt ? fmt.bg : "var(--surface2)", border: `1px solid ${fmt ? fmt.color + "33" : "var(--border)"}`, borderRadius: 6, padding: "2px 6px 2px 5px", fontSize: 11 }}>
                      <span style={{ color: fmt ? fmt.color : "var(--text-dim)", fontWeight: 700, fontSize: 10 }}>{ext}</span>
                      <span style={{ color: "var(--text-muted)", maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name.replace(/\.[^.]+$/, "")}</span>
                      <button onClick={() => setFiles(prev => prev.filter((_, idx) => idx !== i))} style={{ background: "none", border: "none", color: "var(--text-dim)", padding: "0 1px", fontSize: 13, lineHeight: 1, cursor: "pointer" }}>×</button>
                    </div>
                  );
                })}
              </div>
            )}

            {files.length > 0 && status !== "uploading" && (
              <button onClick={handleUpload} style={{ width: "100%", marginTop: 10, background: "var(--accent)", color: "#fff", border: "none", borderRadius: 8, padding: "8px", fontSize: 12, fontWeight: 600 }}>
                Upload {files.length > 1 ? `(${files.length} files)` : ""}
              </button>
            )}
            {status === "uploading" && (
              <div style={{ marginTop: 8, textAlign: "center", fontSize: 12, color: "var(--accent)" }}>
                <span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>◌</span> Processing…
              </div>
            )}
            {msg && (
              <div style={{ marginTop: 8, fontSize: 11, padding: "6px 8px", borderLeft: `2px solid ${status === "error" ? "var(--error)" : "var(--success)"}`, background: status === "error" ? "rgba(220,38,38,0.06)" : "rgba(22,163,74,0.06)", color: status === "error" ? "var(--error)" : "var(--success)", borderRadius: "0 4px 4px 0" }}>{msg}</div>
            )}

            <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
              <div style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 7 }}>Supported formats</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {SUPPORTED_FORMATS.map(f => (
                  <div key={f.ext} style={{ display: "flex", alignItems: "center", gap: 4, background: f.bg, border: `1px solid ${f.color}22`, borderRadius: 6, padding: "3px 8px" }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: f.color }}>{f.ext}</span>
                    <span style={{ fontSize: 9, color: f.color, opacity: 0.8 }}>{f.ext === "CSV" ? "→ SQL" : "→ Vec"}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* History */}
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 8px 12px" }}>
        {history.length === 0 ? (
          <div style={{ padding: "24px 12px", textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>No conversations yet</div>
        ) : (
          <>
            {todayH.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", letterSpacing: "0.06em", textTransform: "uppercase", padding: "8px 12px 4px" }}>Today</div>
                {todayH.map(h => (
                  <button key={h.id} style={{ width: "100%", textAlign: "left", background: "none", border: "none", borderRadius: 8, padding: "8px 12px", fontSize: 13, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    onMouseEnter={e => e.currentTarget.style.background = "var(--surface2)"}
                    onMouseLeave={e => e.currentTarget.style.background = "none"}>
                    {h.title}
                  </button>
                ))}
              </div>
            )}
            {olderH.length > 0 && (
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", letterSpacing: "0.06em", textTransform: "uppercase", padding: "8px 12px 4px" }}>Earlier</div>
                {olderH.map(h => (
                  <button key={h.id} style={{ width: "100%", textAlign: "left", background: "none", border: "none", borderRadius: 8, padding: "8px 12px", fontSize: 13, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    onMouseEnter={e => e.currentTarget.style.background = "var(--surface2)"}
                    onMouseLeave={e => e.currentTarget.style.background = "none"}>
                    {h.title}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Flush button */}
      <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
        <button onClick={onFlush} style={{
          width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          background: "var(--flush-light)",
          border: "1px solid rgba(220,38,38,0.2)",
          borderRadius: 10, padding: "9px 14px",
          color: "var(--flush)", fontSize: 13, fontWeight: 500,
          transition: "all 0.15s",
        }}
          onMouseEnter={e => { e.currentTarget.style.background = "rgba(220,38,38,0.14)"; e.currentTarget.style.borderColor = "rgba(220,38,38,0.4)"; }}
          onMouseLeave={e => { e.currentTarget.style.background = "var(--flush-light)"; e.currentTarget.style.borderColor = "rgba(220,38,38,0.2)"; }}
        >
          <span className="mso" style={{ fontSize: 17 }}>delete_sweep</span>
          Flush knowledge base
        </button>
      </div>

      {/* Footer */}
      {!agentReady && (
        <div style={{ margin: "0 12px 12px", padding: "10px 12px", background: "rgba(217,119,6,0.08)", border: "1px solid rgba(217,119,6,0.2)", borderRadius: 8, fontSize: 11, color: "var(--warn)" }}>
          ⚠ Agent offline · start uvicorn on :8000
        </div>
      )}
      <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 30, height: 30, borderRadius: "50%", background: "var(--accent-light)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <span className="mso" style={{ fontSize: 16, color: "var(--accent)" }}>person</span>
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 500 }}>User</div>
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
            <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: agentReady ? "var(--success)" : "var(--text-dim)", marginRight: 4, verticalAlign: "middle" }} />
            {agentReady ? "Connected" : "Offline"}
          </div>
        </div>
      </div>
    </aside>
  );
}

// ─── ThinkingDots ─────────────────────────────────────────────────────────────
function ThinkingDots() {
  return (
    <div style={{ display: "flex", gap: 5, alignItems: "center", padding: "10px 0" }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", display: "inline-block", animation: `bounce 1.2s infinite ${i * 0.2}s` }} />
      ))}
    </div>
  );
}

// ─── MessageBubble ────────────────────────────────────────────────────────────
function MessageBubble({ msg }) {
  const isUser = msg.role === "user";
  const isError = msg.role === "error";
  const isThinking = msg.role === "thinking";

  return (
    <div style={{ display: "flex", gap: 12, padding: "16px 28px", animation: "fadeUp 0.2s ease", alignItems: "flex-start" }}>
      <div style={{ width: 30, height: 30, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: isUser ? "var(--surface2)" : "var(--accent-light)", border: isUser ? "1px solid var(--border)" : "1px solid var(--accent-mid)", marginTop: 2 }}>
        <span className="mso fill" style={{ fontSize: 15, color: isUser ? "var(--text-muted)" : "var(--accent)" }}>{isUser ? "person" : "bolt"}</span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: isUser ? "var(--text-muted)" : "var(--text)" }}>{isUser ? "You" : "AdvRAG"}</span>
          {msg.ts && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{msg.ts}</span>}
          {isError && <span style={{ fontSize: 10, background: "rgba(220,38,38,0.1)", color: "var(--error)", padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>ERROR</span>}
        </div>
        {isThinking ? <ThinkingDots /> : (
          <div style={{ fontSize: 14, lineHeight: 1.75, color: isError ? "var(--error)" : "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {msg.content}
            {msg.streaming && <span style={{ display: "inline-block", width: 2, height: 15, background: "var(--accent)", marginLeft: 2, verticalAlign: "middle", animation: "blink 0.8s infinite" }} />}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── ChatPanel ────────────────────────────────────────────────────────────────
function ChatPanel({ agentReady, messages, setMessages, needsUpload }) {
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
    setInput(""); if (textRef.current) textRef.current.style.height = "auto";
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
    if (!window.confirm("Clear conversation memory and history?")) return;
    if (cancelRef.current) cancelRef.current();
    try { await resetMemory(); } catch {}
    setMessages([]); setBusy(false);
  };

  const isEmpty = messages.length === 0;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
      {/* Top bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 24px", height: 52, borderBottom: "1px solid var(--border)", background: "var(--surface)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: "var(--serif)", fontSize: 16, fontStyle: "italic", color: "var(--text)" }}>Chat</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {["stream", "full"].map(m => (
            <button key={m} onClick={() => setMode(m)} style={{ fontSize: 11, padding: "4px 12px", borderRadius: 20, border: `1px solid ${mode === m ? "var(--accent)" : "var(--border-strong)"}`, color: mode === m ? "var(--accent)" : "var(--text-dim)", background: mode === m ? "var(--accent-light)" : "transparent", fontWeight: mode === m ? 600 : 400 }}>
              {m === "stream" ? "Streaming" : "Full"}
            </button>
          ))}
          <button onClick={handleReset} style={{ fontSize: 11, padding: "4px 12px", borderRadius: 20, border: "1px solid var(--border-strong)", color: "var(--text-dim)", background: "transparent" }}
            onMouseEnter={e => { e.target.style.color = "var(--error)"; e.target.style.borderColor = "var(--error)"; }}
            onMouseLeave={e => { e.target.style.color = "var(--text-dim)"; e.target.style.borderColor = "var(--border-strong)"; }}>
            Reset
          </button>
        </div>
      </div>

      {/* Needs-upload banner */}
      {needsUpload && (
        <div style={{ background: "rgba(217,119,6,0.07)", borderBottom: "1px solid rgba(217,119,6,0.2)", padding: "10px 24px", display: "flex", alignItems: "center", gap: 8, animation: "fadeUp 0.3s ease" }}>
          <span className="mso fill" style={{ fontSize: 18, color: "var(--warn)", flexShrink: 0 }}>warning</span>
          <span style={{ fontSize: 13, color: "var(--warn)", fontWeight: 500 }}>
            Knowledge base is empty — upload new documents before querying to avoid empty or wrong results.
          </span>
        </div>
      )}

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
        {isEmpty ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 28px", gap: 32 }}>
            <div style={{ position: "relative", width: 120, height: 120 }}>
              <div style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "radial-gradient(circle at 40% 35%, rgba(91,58,245,0.25) 0%, rgba(91,58,245,0.06) 60%, transparent 100%)" }} />
              <div style={{ position: "absolute", inset: 12, borderRadius: "50%", border: "1px solid rgba(91,58,245,0.2)", display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(255,255,255,0.7)" }}>
                <span className="mso fill" style={{ fontSize: 40, color: "var(--accent)", opacity: 0.8 }}>bolt</span>
              </div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontFamily: "var(--serif)", fontSize: 28, fontStyle: "italic", color: "var(--text)", marginBottom: 8 }}>How can I assist you today?</div>
              <div style={{ fontSize: 14, color: "var(--text-muted)" }}>Upload documents or CSVs, then ask anything about your knowledge base.</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, width: "100%", maxWidth: 680 }}>
              {SUGGESTIONS.map((s, i) => (
                <button key={i} onClick={() => { setInput(s.desc); textRef.current?.focus(); }} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: "18px 16px", textAlign: "left", transition: "all 0.15s", cursor: "pointer" }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = "rgba(91,58,245,0.3)"; e.currentTarget.style.boxShadow = "0 4px 16px rgba(91,58,245,0.07)"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.boxShadow = "none"; }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: "var(--accent-light)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 10 }}>
                    <span className="mso" style={{ fontSize: 18, color: "var(--accent)" }}>{s.icon}</span>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, color: "var(--text)" }}>{s.title}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{s.desc}</div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ paddingTop: 8, paddingBottom: 8 }}>
            {messages.map(msg => <MessageBubble key={msg.id} msg={msg} />)}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Input area */}
      <div style={{ padding: "14px 24px 18px", background: "var(--surface)", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
        <div style={{ background: "var(--bg)", border: `1.5px solid ${busy ? "var(--accent)" : "var(--border-strong)"}`, borderRadius: 16, padding: "12px 14px", transition: "border-color 0.2s" }}>
          <textarea ref={textRef} value={input} onChange={handleInput} onKeyDown={handleKey} disabled={busy || !agentReady} placeholder={agentReady ? "Ask anything about your knowledge base…" : "Waiting for agent…"} rows={1}
            style={{ width: "100%", background: "transparent", border: "none", outline: "none", resize: "none", fontSize: 14, color: "var(--text)", lineHeight: 1.6, minHeight: 24, maxHeight: 160, overflowY: "auto", display: "block" }} />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
              ↵ send · shift+↵ newline · <span style={{ color: "var(--accent)", fontWeight: 500 }}>{mode === "stream" ? "streaming" : "full"}</span>
            </div>
            <button onClick={send} disabled={busy || !agentReady || !input.trim()} style={{ width: 36, height: 36, borderRadius: "50%", background: busy ? "var(--surface2)" : "var(--accent)", border: "none", display: "flex", alignItems: "center", justifyContent: "center", color: busy ? "var(--text-dim)" : "#fff", fontSize: 16, transition: "all 0.15s", flexShrink: 0 }}
              onMouseEnter={e => { if (!busy) e.currentTarget.style.transform = "scale(1.07)"; }}
              onMouseLeave={e => { e.currentTarget.style.transform = "none"; }}>
              <span className="mso" style={{ fontSize: 18, color: busy ? "var(--text-dim)" : "#fff" }}>arrow_upward</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── App root ─────────────────────────────────────────────────────────────────
export default function App() {
  const [agentReady, setAgentReady] = useState(false);
  const [messages, setMessages] = useState([]);
  const [history, setHistory] = useState([]);
  const [flushPhase, setFlushPhase] = useState(null); // null | "confirm" | "flushing" | "done"
  const [needsUpload, setNeedsUpload] = useState(false);

  const poll = async () => {
    try {
      const d = await checkHealth();
      setAgentReady(!!d.agent_ready);
    } catch { setAgentReady(false); }
  };

  useEffect(() => { poll(); const id = setInterval(poll, 8000); return () => clearInterval(id); }, []);

  const handleNewChat = async () => {
    if (messages.length > 0) {
      const firstUser = messages.find(m => m.role === "user");
      if (firstUser) {
        setHistory(prev => [{ id: Date.now(), title: firstUser.content.slice(0, 55) + (firstUser.content.length > 55 ? "…" : ""), date: new Date() }, ...prev]);
      }
    }
    try { await resetMemory(); } catch {}
    setMessages([]);
  };

  const handleFlushRequest = () => setFlushPhase("confirm");

  const handleFlushConfirm = async () => {
    setFlushPhase("flushing");
    try {
      await flushAll();
      // also reset chat memory
      try { await resetMemory(); } catch {}
      setMessages([]);
    } catch (e) {
      console.error("Flush error:", e);
    }
    setFlushPhase("done");
    setNeedsUpload(true);
  };

  const handleFlushClose = () => {
    setFlushPhase(null);
  };

  return (
    <>
      <style>{styles}</style>
      <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
        <Sidebar
          agentReady={agentReady}
          history={history}
          onNewChat={handleNewChat}
          onFlush={handleFlushRequest}
          needsUpload={needsUpload}
          onUploadSuccess={() => setNeedsUpload(false)}
        />
        <ChatPanel
          agentReady={agentReady}
          messages={messages}
          setMessages={setMessages}
          needsUpload={needsUpload}
        />
      </div>

      {flushPhase && (
        <FlushOverlay
          phase={flushPhase}
          onConfirm={handleFlushConfirm}
          onCancel={handleFlushClose}
        />
      )}
    </>
  );
}