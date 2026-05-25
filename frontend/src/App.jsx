import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const BASE = import.meta.env.VITE_API_URL || "https://advanced-rag-deployment.onrender.com";

// ─── API ──────────────────────────────────────────────────────────────────────
async function checkHealth() {
  const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(4000) });
  return r.json();
}
async function resetMemory() { await fetch(`${BASE}/chat/memory`, { method: "DELETE" }); }
async function flushAll() {
  const r = await fetch(`${BASE}/flush`, { method: "DELETE" });
  if (!r.ok) { const e = await r.json().catch(() => ({ detail: r.statusText })); throw new Error(e.detail || "Flush failed"); }
  return r.json();
}
async function chatFull(query) {
  const r = await fetch(`${BASE}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
  if (!r.ok) { const e = await r.json().catch(() => ({ detail: r.statusText })); throw new Error(e.detail || "Chat request failed"); }
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
  if (!r.ok) { const e = await r.json().catch(() => ({ detail: r.statusText })); throw new Error(e.detail || "Upload failed"); }
  return r.json();
}
async function uploadCSV(file, tableName = "") {
  const form = new FormData();
  form.append("file", file);
  if (tableName) form.append("table_name", tableName);
  const r = await fetch(`${BASE}/ingest/csv`, { method: "POST", body: form });
  if (!r.ok) { const e = await r.json().catch(() => ({ detail: r.statusText })); throw new Error(e.detail || "CSV upload failed"); }
  return r.json();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ts() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, "0")).join(":");
}
function estimateSeconds(files) {
  const totalKB = files.reduce((acc, f) => acc + (f.size || 0), 0) / 1024;
  return Math.max(8, Math.round(totalKB * 0.12 + 5));
}
function genId() { return Math.random().toString(36).slice(2, 10); }
function chatPreview(messages) {
  const first = messages.find(m => m.role === "user");
  if (!first) return "New chat";
  return first.content.slice(0, 52) + (first.content.length > 52 ? "…" : "");
}

const SUGGESTIONS = [
  { icon: "lightbulb", label: "Generate Ideas" },
  { icon: "travel_explore", label: "Search Docs" },
  { icon: "bar_chart", label: "Analyze Data" },
  { icon: "question_mark", label: "Ask Anything" },
];

// ─── Sizes ────────────────────────────────────────────────────────────────────
const RAIL_W = 48;       // collapsed icon rail width
const SIDEBAR_W = 260;   // expanded sidebar width

// ─── Global Styles ────────────────────────────────────────────────────────────
const STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #1a1a1a;
    --surface: #1f1f1f;
    --surface2: #2a2a2a;
    --surface3: #333;
    --border: rgba(255,255,255,0.08);
    --border-strong: rgba(255,255,255,0.14);
    --primary: #ffffff;
    --on-surface: #e8e6eb;
    --on-surface-var: #a09daa;
    --outline: #666;
    --success: #34d399;
    --warn: #fbbf24;
    --error: #f87171;
    --accent: #cc785c;
    --violet: #9147ff;
    --violet-dim: rgba(145,71,255,0.14);
    --violet-light: #bf94ff;
    --sans: 'Plus Jakarta Sans', system-ui, sans-serif;
    --rail-w: ${RAIL_W}px;
    --sidebar-w: ${SIDEBAR_W}px;
    --topbar-h: 52px;
  }
  html, body, #root { height:100%; background:var(--bg); font-family:var(--sans); color:var(--on-surface); font-size:14px; line-height:1.6; overflow:hidden; }
  button { font-family:var(--sans); cursor:pointer; border:none; background:none; }
  textarea, input { font-family:var(--sans); }
  ::-webkit-scrollbar { width:4px; }
  ::-webkit-scrollbar-track { background:transparent; }
  ::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.1); border-radius:4px; }

  .mso {
    font-family:'Material Symbols Outlined';
    font-weight:300; font-style:normal; font-size:20px; line-height:1;
    letter-spacing:normal; text-transform:none; display:inline-block;
    white-space:nowrap; direction:ltr; user-select:none;
    font-feature-settings:'liga'; -webkit-font-smoothing:antialiased;
    font-variation-settings:'FILL' 0,'wght' 300,'GRAD' 0,'opsz' 24;
  }
  .mso.fill { font-variation-settings:'FILL' 1,'wght' 400,'GRAD' 0,'opsz' 24; }

  /* ── Rail (always visible, collapsed state) ── */
  .rail {
    position:fixed; left:0; top:0; height:100%;
    width:var(--rail-w);
    background:var(--surface);
    border-right:1px solid var(--border);
    display:flex; flex-direction:column; align-items:center;
    z-index:200;
    padding: 8px 0;
    gap:2px;
  }

  /* ── Expanded sidebar panel (slides in over rail) ── */
  .sidebar-exp {
    position:fixed; left:0; top:0; height:100%;
    width:var(--sidebar-w);
    background:var(--surface);
    border-right:1px solid var(--border);
    display:flex; flex-direction:column;
    z-index:201;
    transform:translateX(calc(-1 * var(--sidebar-w)));
    transition:transform 0.22s cubic-bezier(0.4,0,0.2,1);
    overflow:hidden;
  }
  .sidebar-exp.open { transform:translateX(0); }

  /* ── Overlay behind expanded sidebar ── */
  .sidebar-overlay {
    position:fixed; inset:0; z-index:199;
    background:rgba(0,0,0,0.35);
    opacity:0; pointer-events:none;
    transition:opacity 0.22s;
  }
  .sidebar-overlay.visible { opacity:1; pointer-events:all; }

  /* Main area always offset by rail */
  .main-area {
    margin-left:var(--rail-w);
    height:100vh;
    display:flex; flex-direction:column;
    overflow:hidden; position:relative;
  }

  /* ── Rail icon button ── */
  .rail-btn {
    width:36px; height:36px; border-radius:8px;
    display:flex; align-items:center; justify-content:center;
    color:var(--outline); transition:all 0.12s; cursor:pointer;
    flex-shrink:0; position:relative;
  }
  .rail-btn:hover { background:rgba(255,255,255,0.08); color:var(--primary); }
  .rail-btn.active { background:rgba(255,255,255,0.1); color:var(--primary); }

  /* ── Sidebar nav rows (expanded) ── */
  .sb-row {
    display:flex; align-items:center; gap:12px;
    padding:7px 14px; border-radius:8px; cursor:pointer;
    transition:background 0.1s; color:var(--on-surface-var);
    font-size:14px; font-weight:500; user-select:none;
    text-align:left; width:100%;
  }
  .sb-row:hover { background:rgba(255,255,255,0.06); color:var(--primary); }

  /* ── Chat history rows ── */
  .chat-row {
    display:flex; align-items:center; gap:0;
    padding:5px 12px; border-radius:7px; cursor:pointer;
    transition:background 0.1s; position:relative;
    min-height:32px;
  }
  .chat-row:hover { background:rgba(255,255,255,0.06); }
  .chat-row.active { background:rgba(255,255,255,0.09); }
  .chat-row-text {
    flex:1; font-size:13.5px; color:var(--on-surface);
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  }
  .chat-row.active .chat-row-text { color:var(--primary); font-weight:500; }
  .chat-row-menu { opacity:0; transition:opacity 0.1s; flex-shrink:0; }
  .chat-row:hover .chat-row-menu { opacity:1; }

  /* ── Context menu ── */
  .ctx-menu {
    position:fixed; background:var(--surface2);
    border:1px solid var(--border-strong); border-radius:10px;
    padding:4px 0; z-index:400; min-width:148px;
    box-shadow:0 8px 28px rgba(0,0,0,0.5);
    animation:ctxIn 0.1s ease;
  }
  @keyframes ctxIn { from{opacity:0;transform:scale(0.96)} to{opacity:1;transform:none} }
  .ctx-item {
    display:flex; align-items:center; gap:9px;
    padding:8px 14px; font-size:13px; cursor:pointer;
    transition:background 0.1s; color:var(--on-surface);
  }
  .ctx-item:hover { background:rgba(255,255,255,0.07); }
  .ctx-item.danger { color:var(--error); }
  .ctx-item.danger:hover { background:rgba(248,113,113,0.09); }

  .rename-input {
    flex:1; background:rgba(255,255,255,0.07);
    border:1px solid rgba(255,255,255,0.16);
    border-radius:5px; padding:2px 7px; color:var(--primary);
    font-size:13px; outline:none;
  }

  /* ── Markdown ── */
  .md-chat { font-size:14px; line-height:1.78; color:var(--on-surface); }
  .md-chat p { margin-bottom:10px; }
  .md-chat p:last-child { margin-bottom:0; }
  .md-chat strong { color:#fff; font-weight:600; }
  .md-chat em { color:var(--on-surface-var); }
  .md-chat h1,.md-chat h2,.md-chat h3 { color:#fff; font-weight:700; margin:16px 0 8px; }
  .md-chat h1{font-size:17px}.md-chat h2{font-size:15px}.md-chat h3{font-size:14px}
  .md-chat ul,.md-chat ol { padding-left:20px; margin-bottom:10px; }
  .md-chat li { margin-bottom:4px; }
  .md-chat code { font-family:monospace; font-size:12px; background:rgba(145,71,255,0.13); color:#bf94ff; padding:2px 6px; border-radius:4px; border:1px solid rgba(145,71,255,0.22); }
  .md-chat pre { background:#0d0d10; border:1px solid rgba(255,255,255,0.08); border-left:2px solid var(--violet); padding:14px 16px; overflow-x:auto; margin:12px 0; border-radius:8px; }
  .md-chat pre code { background:none; padding:0; color:#e2e2e2; border:none; font-size:13px; }
  .md-chat table { border-collapse:collapse; width:100%; margin:12px 0; font-size:13px; }
  .md-chat th { background:rgba(255,255,255,0.05); color:#fff; padding:8px 14px; text-align:left; border:1px solid var(--border-strong); font-weight:600; }
  .md-chat td { padding:7px 14px; border:1px solid var(--border); }
  .md-chat tr:nth-child(even) td { background:rgba(255,255,255,0.02); }
  .md-chat blockquote { border-left:2px solid var(--violet); padding:8px 16px; color:var(--on-surface-var); margin:10px 0; background:var(--violet-dim); border-radius:0 6px 6px 0; }
  .md-chat a { color:#bf94ff; text-decoration:none; }
  .md-chat a:hover { text-decoration:underline; }
  .md-chat hr { border:none; border-top:1px solid var(--border); margin:14px 0; }

  .sb-section-label {
    font-size:12px; font-weight:600; color:var(--outline);
    padding:10px 14px 4px; letter-spacing:0;
  }

  @keyframes fadeUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:none} }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
  @keyframes spin { to{transform:rotate(360deg)} }
  @keyframes popIn { from{opacity:0;transform:scale(0.96) translateY(6px)} to{opacity:1;transform:none} }
  @keyframes msgSlideIn { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:none} }
  @keyframes bounce { 0%,80%,100%{transform:scale(0.5);opacity:0.3} 40%{transform:scale(1);opacity:1} }
  @keyframes progressPulse { 0%,100%{opacity:0.6} 50%{opacity:1} }
  @keyframes glow-pulse { 0%,100%{opacity:0.7} 50%{opacity:1} }
  @keyframes flushBarFill { 0%{width:0%} 85%{width:90%} 100%{width:95%} }
  @keyframes flushScan { 0%{top:0%;opacity:0.7} 100%{top:100%;opacity:0} }
  @keyframes flushRowSlide { 0%{opacity:0;transform:translateX(-8px)} 100%{opacity:1;transform:none} }
  @keyframes flushBlink { 0%,100%{opacity:1} 50%{opacity:0} }
  @keyframes flushSuccessScale { 0%{transform:scale(0.4);opacity:0} 60%{transform:scale(1.15)} 100%{transform:scale(1);opacity:1} }
  @keyframes flushOverlayIn { from{opacity:0} to{opacity:1} }
`;

// ─── Context Menu ─────────────────────────────────────────────────────────────
function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef();
  useEffect(() => {
    const h = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [onClose]);
  return (
    <div ref={ref} className="ctx-menu" style={{ top: y, left: x }}>
      {items.map((item, i) => (
        <div key={i} className={`ctx-item${item.danger ? " danger" : ""}`}
          onClick={() => { item.action(); onClose(); }}>
          <span className="mso" style={{ fontSize: 16 }}>{item.icon}</span>
          {item.label}
        </div>
      ))}
    </div>
  );
}

// ─── Flush Overlay ────────────────────────────────────────────────────────────
function FlushOverlay({ phase, onConfirm, onCancel }) {
  return (
    <div style={{ position:"fixed", inset:0, zIndex:500, background:"rgba(0,0,0,0.72)", backdropFilter:"blur(8px)", display:"flex", alignItems:"center", justifyContent:"center", animation:"flushOverlayIn 0.2s ease" }}>
      {phase === "confirm" && (
        <div style={{ background:"var(--surface2)", border:"1px solid rgba(248,113,113,0.25)", borderRadius:20, padding:"36px 40px 32px", maxWidth:420, width:"90%", animation:"popIn 0.2s ease", textAlign:"center", boxShadow:"0 32px 80px rgba(0,0,0,0.6)" }}>
          <div style={{ width:56, height:56, borderRadius:"50%", background:"rgba(248,113,113,0.1)", border:"1px solid rgba(248,113,113,0.3)", display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 20px" }}>
            <span className="mso" style={{ fontSize:24, color:"var(--error)" }}>delete_sweep</span>
          </div>
          <div style={{ fontSize:19, fontWeight:700, color:"var(--primary)", marginBottom:10 }}>Flush knowledge base?</div>
          <div style={{ fontSize:13, color:"var(--on-surface-var)", lineHeight:1.7, marginBottom:28 }}>
            This permanently deletes <strong style={{ color:"var(--primary)" }}>all Pinecone vectors</strong> and <strong style={{ color:"var(--primary)" }}>all SQLite tables</strong>.<br /><br />
            <span style={{ color:"var(--error)" }}>You must re-upload files before querying again.</span>
          </div>
          <div style={{ display:"flex", gap:10 }}>
            <button onClick={onCancel} style={{ flex:1, padding:"10px", borderRadius:10, border:"1px solid var(--border-strong)", color:"var(--on-surface-var)", fontSize:13, fontWeight:500, cursor:"pointer", background:"none" }}>Cancel</button>
            <button onClick={onConfirm} style={{ flex:1, padding:"10px", borderRadius:10, background:"var(--error)", color:"#fff", fontSize:13, fontWeight:600, cursor:"pointer", border:"none" }}>Yes, flush everything</button>
          </div>
        </div>
      )}
      {phase === "flushing" && (
        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:28, animation:"popIn 0.2s ease" }}>
          <div style={{ width:380, background:"#0d0d0f", border:"1px solid rgba(248,113,113,0.25)", borderRadius:16, overflow:"hidden", boxShadow:"0 32px 80px rgba(0,0,0,0.7)" }}>
            <div style={{ display:"flex", alignItems:"center", gap:8, padding:"12px 16px", borderBottom:"1px solid rgba(255,255,255,0.06)", background:"rgba(255,255,255,0.02)" }}>
              <div style={{ width:10, height:10, borderRadius:"50%", background:"rgba(248,113,113,0.7)" }} />
              <div style={{ width:10, height:10, borderRadius:"50%", background:"rgba(251,191,36,0.4)" }} />
              <div style={{ width:10, height:10, borderRadius:"50%", background:"rgba(52,211,153,0.3)" }} />
              <span style={{ marginLeft:8, fontSize:11, color:"rgba(255,255,255,0.3)", fontFamily:"monospace", letterSpacing:"0.05em" }}>flush.sh</span>
            </div>
            <div style={{ padding:"16px 20px", fontFamily:"monospace", fontSize:12, lineHeight:2, position:"relative", overflow:"hidden" }}>
              <div style={{ position:"absolute", left:0, right:0, height:28, background:"linear-gradient(transparent,rgba(248,113,113,0.04),transparent)", pointerEvents:"none", animation:"flushScan 1.6s ease-in-out infinite" }} />
              {[
                { prefix:"$", text:"connecting to pinecone…", color:"rgba(255,255,255,0.5)", delay:"0s" },
                { prefix:"✓", text:"index found · deleting vectors", color:"rgba(248,113,113,0.8)", delay:"0.15s" },
                { prefix:"✓", text:"sparse vectors cleared", color:"rgba(248,113,113,0.8)", delay:"0.3s" },
                { prefix:"$", text:"connecting to sqlite…", color:"rgba(255,255,255,0.5)", delay:"0.45s" },
                { prefix:"✓", text:"dropping tables", color:"rgba(248,113,113,0.8)", delay:"0.6s" },
                { prefix:"…", text:"finalising", color:"rgba(255,255,255,0.3)", delay:"0.75s", blink:true },
              ].map((row, i) => (
                <div key={i} style={{ display:"flex", gap:12, animation:"flushRowSlide 0.3s ease both", animationDelay:row.delay }}>
                  <span style={{ color:row.color, minWidth:14, animation:row.blink ? "flushBlink 1s infinite" : "none" }}>{row.prefix}</span>
                  <span style={{ color:row.blink ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.75)" }}>{row.text}</span>
                </div>
              ))}
            </div>
            <div style={{ padding:"0 20px 18px" }}>
              <div style={{ height:3, background:"rgba(255,255,255,0.06)", borderRadius:99, overflow:"hidden" }}>
                <div style={{ height:"100%", background:"linear-gradient(90deg,rgba(248,113,113,0.9),rgba(248,113,113,0.4))", borderRadius:99, animation:"flushBarFill 3s cubic-bezier(0.4,0,0.2,1) forwards" }} />
              </div>
            </div>
          </div>
          <div style={{ fontSize:12, color:"rgba(255,255,255,0.3)" }}>Do not close this tab</div>
        </div>
      )}
      {phase === "done" && (
        <div style={{ background:"var(--surface2)", border:"1px solid rgba(52,211,153,0.2)", borderRadius:20, padding:"36px 40px 32px", maxWidth:420, width:"90%", animation:"popIn 0.3s ease", textAlign:"center", boxShadow:"0 32px 80px rgba(0,0,0,0.6)" }}>
          <div style={{ width:56, height:56, borderRadius:"50%", background:"rgba(52,211,153,0.1)", border:"1px solid rgba(52,211,153,0.3)", display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 20px", animation:"flushSuccessScale 0.4s ease" }}>
            <span className="mso fill" style={{ fontSize:24, color:"var(--success)" }}>check_circle</span>
          </div>
          <div style={{ fontSize:19, fontWeight:700, color:"var(--primary)", marginBottom:12 }}>Knowledge base flushed</div>
          <div style={{ background:"rgba(251,191,36,0.07)", border:"1px solid rgba(251,191,36,0.2)", borderRadius:12, padding:"12px 16px", marginBottom:24, display:"flex", gap:10, alignItems:"flex-start", textAlign:"left" }}>
            <span className="mso fill" style={{ fontSize:18, color:"var(--warn)", flexShrink:0, marginTop:1 }}>warning</span>
            <div style={{ fontSize:12, color:"var(--on-surface-var)", lineHeight:1.6 }}>
              <strong style={{ color:"var(--warn)", display:"block", marginBottom:2 }}>Upload files before querying</strong>
              The knowledge base is now empty.
            </div>
          </div>
          <button onClick={onCancel} style={{ width:"100%", padding:"11px", borderRadius:10, background:"var(--primary)", color:"#000", fontSize:13, fontWeight:600, cursor:"pointer", border:"none" }}>Got it</button>
        </div>
      )}
    </div>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────
const TOAST_STYLES = {
  success:{ bg:"rgba(52,211,153,0.12)", border:"rgba(52,211,153,0.4)", color:"var(--success)", icon:"check_circle" },
  error:  { bg:"rgba(248,113,113,0.12)", border:"rgba(248,113,113,0.4)", color:"var(--error)", icon:"error" },
  info:   { bg:"rgba(255,255,255,0.07)", border:"rgba(255,255,255,0.15)", color:"var(--on-surface-var)", icon:"info" },
  warn:   { bg:"rgba(251,191,36,0.1)", border:"rgba(251,191,36,0.35)", color:"var(--warn)", icon:"warning" },
};
function Toast({ toast, onDismiss }) {
  if (!toast) return null;
  const s = TOAST_STYLES[toast.type] || TOAST_STYLES.info;
  return (
    <div style={{ position:"fixed", bottom:110, left:"50%", transform:"translateX(-50%)", background:s.bg, border:`1px solid ${s.border}`, color:s.color, borderRadius:12, padding:"10px 18px", fontSize:13, fontWeight:500, zIndex:400, animation:"fadeUp 0.2s ease", display:"flex", alignItems:"center", gap:10, boxShadow:"0 8px 40px rgba(0,0,0,0.5)", minWidth:240, maxWidth:380, backdropFilter:"blur(12px)" }}>
      <span className="mso fill" style={{ fontSize:18, flexShrink:0 }}>{s.icon}</span>
      <span style={{ flex:1 }}>{toast.msg}</span>
      <button onClick={onDismiss} style={{ color:"inherit", opacity:0.5, display:"flex", alignItems:"center" }}><span className="mso" style={{ fontSize:16 }}>close</span></button>
    </div>
  );
}

// ─── Thinking Dots ────────────────────────────────────────────────────────────
function ThinkingDots() {
  return (
    <div style={{ display:"flex", gap:5, alignItems:"center", padding:"6px 0" }}>
      {[0,1,2].map(i => <span key={i} style={{ width:7, height:7, borderRadius:"50%", background:"var(--violet)", animation:`bounce 1.2s infinite ${i*0.2}s`, display:"inline-block", opacity:0.7 }} />)}
    </div>
  );
}

// ─── Message Bubble ───────────────────────────────────────────────────────────
function MessageBubble({ msg }) {
  const isUser = msg.role === "user";
  const isError = msg.role === "error";
  const isThinking = msg.role === "thinking";
  return (
    <div style={{ display:"flex", flexDirection:"column", animation:"msgSlideIn 0.25s ease" }}>
      {isUser ? (
        <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:20, paddingLeft:80 }}>
          <div style={{ background:"rgba(255,255,255,0.07)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:"18px 18px 4px 18px", padding:"11px 16px", fontSize:14, color:"#fff", lineHeight:1.65, maxWidth:"100%", whiteSpace:"pre-wrap", wordBreak:"break-word" }}>
            {msg.content}
          </div>
        </div>
      ) : (
        <div style={{ display:"flex", gap:12, alignItems:"flex-start", marginBottom:24 }}>
          <div style={{ width:32, height:32, borderRadius:9, flexShrink:0, background:"linear-gradient(135deg,rgba(145,71,255,0.25),rgba(88,101,242,0.15))", border:"1px solid rgba(145,71,255,0.3)", display:"flex", alignItems:"center", justifyContent:"center", marginTop:2 }}>
            <span className="mso" style={{ fontSize:17, color:"#bf94ff", fontVariationSettings:"'FILL' 0,'wght' 200" }}>all_inclusive</span>
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
              <span style={{ fontSize:11, fontWeight:700, letterSpacing:"0.06em", color:isError ? "var(--error)" : "rgba(145,71,255,0.9)" }}>{isError ? "ERROR" : "AEYTHON"}</span>
              {msg.ts && <span style={{ fontSize:10, color:"var(--outline)" }}>{msg.ts}</span>}
              {msg.streaming && <span style={{ fontSize:10, color:"var(--outline)", display:"flex", alignItems:"center", gap:3 }}><span style={{ width:5, height:5, borderRadius:"50%", background:"var(--violet)", display:"inline-block", animation:"progressPulse 1s infinite" }} />streaming</span>}
            </div>
            <div style={{ fontSize:14, lineHeight:1.75 }}>
              {isThinking ? <ThinkingDots />
                : isError
                  ? <div style={{ color:"var(--error)", background:"rgba(248,113,113,0.07)", border:"1px solid rgba(248,113,113,0.15)", borderRadius:8, padding:"10px 14px", fontSize:13 }}>{msg.content}</div>
                  : <div className="md-chat">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content || ""}</ReactMarkdown>
                      {msg.streaming && <span style={{ display:"inline-block", width:9, height:15, background:"var(--violet)", marginLeft:2, verticalAlign:"middle", borderRadius:2, animation:"blink 0.8s infinite" }} />}
                    </div>
              }
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Attach Dropup ────────────────────────────────────────────────────────────
function AttachDropup({ onClose, onIngest }) {
  const docsRef = useRef();
  const csvRef = useRef();
  const handle = async (files) => { onClose(); await onIngest(Array.from(files)); };
  return (
    <div style={{ position:"absolute", bottom:"calc(100% + 10px)", left:0, background:"var(--surface2)", border:"1px solid var(--border-strong)", borderRadius:14, padding:"6px 0", width:230, zIndex:60, boxShadow:"0 16px 48px rgba(0,0,0,0.5)", animation:"fadeUp 0.15s ease" }}>
      <div style={{ padding:"6px 16px 8px", fontSize:10, letterSpacing:"0.1em", color:"var(--outline)", borderBottom:"1px solid var(--border)", marginBottom:4, fontWeight:700 }}>ATTACH FILES</div>
      {[
        { ref:docsRef, accept:".pdf,.docx,.md,.txt", multiple:true, icon:"description", iconColor:"var(--primary)", bg:"rgba(255,255,255,0.06)", border:"var(--border-strong)", label:"Documents", sub:"PDF, DOCX, MD, TXT" },
        { ref:csvRef, accept:".csv", multiple:false, icon:"table_chart", iconColor:"var(--success)", bg:"rgba(52,211,153,0.08)", border:"rgba(52,211,153,0.2)", label:"Structured CSV", sub:"CSV → SQL analytics" },
      ].map((item, i) => (
        <div key={i}>
          <button onClick={() => item.ref.current.click()} style={{ width:"100%", background:"none", border:"none", display:"flex", alignItems:"center", gap:12, padding:"10px 16px", cursor:"pointer", textAlign:"left", transition:"background 0.12s" }}
            onMouseEnter={e => e.currentTarget.style.background="rgba(255,255,255,0.05)"}
            onMouseLeave={e => e.currentTarget.style.background="none"}>
            <div style={{ width:32, height:32, borderRadius:8, background:item.bg, border:`1px solid ${item.border}`, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
              <span className="mso" style={{ fontSize:16, color:item.iconColor }}>{item.icon}</span>
            </div>
            <div>
              <div style={{ fontSize:13, fontWeight:600, color:"var(--primary)" }}>{item.label}</div>
              <div style={{ fontSize:11, color:"var(--outline)" }}>{item.sub}</div>
            </div>
          </button>
          <input ref={item.ref} type="file" accept={item.accept} multiple={item.multiple} style={{ display:"none" }} onChange={e => handle(e.target.files)} />
        </div>
      ))}
    </div>
  );
}

// ─── Ingestion Progress ───────────────────────────────────────────────────────
function IngestionProgress({ job, onDismiss }) {
  const [elapsed, setElapsed] = useState(0);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!job) return;
    setElapsed(0); setDone(false);
    const iv = setInterval(() => setElapsed(e => { const n=e+1; if(n>=job.estimatedSeconds) clearInterval(iv); return n; }), 1000);
    return () => clearInterval(iv);
  }, [job]);
  useEffect(() => { if (job?.completed) setDone(true); }, [job?.completed]);
  if (!job) return null;
  const progress = done ? 100 : Math.min(95, (elapsed/job.estimatedSeconds)*100);
  const remaining = Math.max(0, job.estimatedSeconds - elapsed);
  return (
    <div style={{ position:"fixed", bottom:120, left:"50%", transform:"translateX(-50%)", width:360, background:"#111113", border:"1px solid rgba(145,71,255,0.3)", borderRadius:14, overflow:"hidden", zIndex:400, boxShadow:"0 16px 48px rgba(0,0,0,0.5)", animation:"fadeUp 0.25s ease" }}>
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 16px 8px" }}>
        <div style={{ width:28, height:28, borderRadius:7, background:"rgba(145,71,255,0.12)", border:"1px solid rgba(145,71,255,0.25)", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
          {done ? <span className="mso fill" style={{ fontSize:16, color:"var(--success)" }}>check</span>
                : <span className="mso" style={{ fontSize:16, color:"var(--violet)", animation:"spin 1.5s linear infinite", display:"inline-block" }}>refresh</span>}
        </div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:13, fontWeight:600, color:"#fff", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{done ? "Ingestion complete" : "Indexing documents…"}</div>
          <div style={{ fontSize:11, color:"var(--outline)", marginTop:1 }}>{done ? job.fileNames : `${job.fileNames} · ~${remaining}s remaining`}</div>
        </div>
        {done && <button onClick={onDismiss} style={{ color:"var(--outline)", display:"flex", alignItems:"center" }}><span className="mso" style={{ fontSize:16 }}>close</span></button>}
      </div>
      <div style={{ height:3, background:"rgba(255,255,255,0.05)" }}>
        <div style={{ height:"100%", width:`${progress}%`, background:done ? "var(--success)" : "var(--violet)", transition:"width 1s linear, background 0.3s" }} />
      </div>
    </div>
  );
}

// ─── SIDEBAR ─────────────────────────────────────────────────────────────────
// Collapsed = thin icon rail (Image 1)
// Expanded  = full panel slides in (Image 2)
function Sidebar({ open, onOpen, onClose, agentReady, chats, activeChatId, onSelectChat, onNewChat, onDeleteChat, onRenameChat, uploadedFiles, onFlush }) {
  const [search, setSearch] = useState("");
  const [ctxMenu, setCtxMenu] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  const [renameVal, setRenameVal] = useState("");
  const renameRef = useRef();

  useEffect(() => { if (renamingId && renameRef.current) renameRef.current.focus(); }, [renamingId]);

  const filtered = chats.filter(c =>
    (c.title || chatPreview(c.messages)).toLowerCase().includes(search.toLowerCase())
  );
  const openCtx = (e, chatId) => { e.preventDefault(); e.stopPropagation(); setCtxMenu({ x:e.clientX, y:e.clientY, chatId }); };
  const startRename = (chatId, currentTitle) => { setRenamingId(chatId); setRenameVal(currentTitle || chatPreview(chats.find(c=>c.id===chatId)?.messages||[])); };
  const commitRename = () => { if (renamingId && renameVal.trim()) onRenameChat(renamingId, renameVal.trim()); setRenamingId(null); };

  // Avatar initials for bottom
  const initials = "A";

  return (
    <>
      {/* ── Always-visible icon rail (collapsed state = Image 1) ── */}
      <div className="rail">
        {/* Toggle button — the □ icon that opens sidebar */}
        <button className="rail-btn" onClick={onOpen} title="Open sidebar"
          style={{ marginBottom:4 }}>
          {/* Exact Claude sidebar toggle: two-rectangle icon */}
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="1" y="1" width="16" height="16" rx="3" stroke="currentColor" strokeWidth="1.5"/>
            <line x1="6" y1="1" x2="6" y2="17" stroke="currentColor" strokeWidth="1.5"/>
          </svg>
        </button>

        <div style={{ width:28, height:1, background:"var(--border)", margin:"4px 0" }} />

        {/* New chat */}
        <button className="rail-btn" onClick={onNewChat} title="New chat">
          <span className="mso" style={{ fontSize:20 }}>add</span>
        </button>
        {/* Search */}
        <button className="rail-btn" onClick={onOpen} title="Search chats">
          <span className="mso" style={{ fontSize:20 }}>search</span>
        </button>
        {/* Chats */}
        <button className="rail-btn" onClick={onOpen} title="Chats">
          <span className="mso" style={{ fontSize:20 }}>chat_bubble_outline</span>
        </button>
        {/* Uploaded files */}
        <button className="rail-btn" onClick={onOpen} title="Uploaded files">
          <span className="mso" style={{ fontSize:20 }}>folder_open</span>
        </button>
        {/* Knowledge base */}
        <button className="rail-btn" onClick={onOpen} title="Knowledge base">
          <span className="mso" style={{ fontSize:20 }}>hub</span>
        </button>
        {/* Flush */}
        <button className="rail-btn" onClick={onFlush} title="Flush knowledge base"
          onMouseEnter={e => { e.currentTarget.style.color="var(--error)"; e.currentTarget.style.background="rgba(248,113,113,0.1)"; }}
          onMouseLeave={e => { e.currentTarget.style.color=""; e.currentTarget.style.background=""; }}>
          <span className="mso" style={{ fontSize:20 }}>delete_sweep</span>
        </button>

        {/* Spacer */}
        <div style={{ flex:1 }} />

        {/* Agent status dot badge on avatar */}
        <div style={{ position:"relative", marginBottom:4 }}>
          <div style={{ width:32, height:32, borderRadius:"50%", background:"linear-gradient(135deg,#3a3a3e,#2e2e33)", border:"1.5px solid rgba(255,255,255,0.12)", display:"flex", alignItems:"center", justifyContent:"center", cursor:"default" }}>
            <span style={{ fontSize:13, fontWeight:700, color:"#fff" }}>{initials}</span>
          </div>
          <div style={{ position:"absolute", bottom:0, right:0, width:9, height:9, borderRadius:"50%", background:agentReady ? "var(--success)" : "var(--outline)", border:"1.5px solid var(--surface)", boxShadow:agentReady ? "0 0 6px rgba(52,211,153,0.7)" : "none" }} />
        </div>
      </div>

      {/* ── Overlay ── */}
      <div className={`sidebar-overlay${open ? " visible" : ""}`} onClick={onClose} />

      {/* ── Expanded sidebar panel (Image 2) ── */}
      <div className={`sidebar-exp${open ? " open" : ""}`}>

        {/* Header: "Aeython" wordmark + close toggle */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"13px 14px 10px", flexShrink:0 }}>
          <span style={{ fontSize:17, fontWeight:700, color:"var(--primary)", letterSpacing:"-0.01em" }}>Aeython</span>
          {/* Same □ icon to close */}
          <button onClick={onClose} title="Close sidebar"
            style={{ width:32, height:32, borderRadius:7, display:"flex", alignItems:"center", justifyContent:"center", color:"var(--outline)", background:"none", border:"none", cursor:"pointer", transition:"all 0.13s", flexShrink:0 }}
            onMouseEnter={e => { e.currentTarget.style.background="rgba(255,255,255,0.08)"; e.currentTarget.style.color="var(--primary)"; }}
            onMouseLeave={e => { e.currentTarget.style.background="none"; e.currentTarget.style.color="var(--outline)"; }}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="1" y="1" width="16" height="16" rx="3" stroke="currentColor" strokeWidth="1.5"/>
              <line x1="6" y1="1" x2="6" y2="17" stroke="currentColor" strokeWidth="1.5"/>
            </svg>
          </button>
        </div>

        {/* Nav rows */}
        <div style={{ padding:"0 8px", flexShrink:0 }}>
          {/* New chat */}
          <button className="sb-row" onClick={() => { onNewChat(); onClose(); }}>
            <span className="mso" style={{ fontSize:20, color:"var(--outline)", flexShrink:0 }}>add</span>
            New chat
          </button>
          {/* Search */}
          <button className="sb-row" onClick={() => {}}>
            <span className="mso" style={{ fontSize:20, color:"var(--outline)", flexShrink:0 }}>search</span>
            Search
          </button>
          {/* Chats label — not a nav but matches Claude structure */}
          <button className="sb-row" style={{ cursor:"default", pointerEvents:"none" }}>
            <span className="mso" style={{ fontSize:20, color:"var(--outline)", flexShrink:0 }}>chat_bubble_outline</span>
            Chats
          </button>
        </div>

        {/* Uploaded files block */}
        {uploadedFiles.length > 0 && (
          <div style={{ margin:"4px 8px 0", flexShrink:0 }}>
            <button className="sb-row" style={{ cursor:"default", pointerEvents:"none" }}>
              <span className="mso" style={{ fontSize:20, color:"var(--outline)", flexShrink:0 }}>folder_open</span>
              <span style={{ flex:1 }}>Uploaded files</span>
              <span style={{ fontSize:11, fontWeight:700, color:"var(--violet)", background:"var(--violet-dim)", borderRadius:99, padding:"1px 7px", flexShrink:0 }}>{uploadedFiles.length}</span>
            </button>
            <div style={{ marginLeft:44, marginBottom:4, display:"flex", flexDirection:"column", gap:2, maxHeight:96, overflowY:"auto" }}>
              {uploadedFiles.map((f, i) => {
                const ext = f.name.split(".").pop().toUpperCase();
                const extColor = { PDF:"#f87171", DOCX:"#60a5fa", MD:"#a3e635", TXT:"#94a3b8", CSV:"#34d399" }[ext] || "#bf94ff";
                return (
                  <div key={i} style={{ display:"flex", alignItems:"center", gap:7, padding:"2px 4px" }}>
                    <span style={{ fontSize:9, fontWeight:700, color:extColor, background:`${extColor}1a`, padding:"1px 5px", borderRadius:3, flexShrink:0 }}>{ext}</span>
                    <span style={{ fontSize:12, color:"var(--on-surface-var)", flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{f.name}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Divider */}
        <div style={{ height:1, background:"var(--border)", margin:"6px 8px 0", flexShrink:0 }} />

        {/* Search box (inline in expanded) */}
        <div style={{ padding:"6px 10px 2px", flexShrink:0 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, background:"rgba(255,255,255,0.04)", border:"1px solid var(--border)", borderRadius:8, padding:"5px 10px" }}>
            <span className="mso" style={{ fontSize:15, color:"var(--outline)" }}>search</span>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search chats…"
              style={{ background:"none", border:"none", outline:"none", color:"var(--primary)", fontSize:13, flex:1, width:0 }} />
            {search && <button onClick={() => setSearch("")} style={{ color:"var(--outline)", display:"flex", alignItems:"center" }}><span className="mso" style={{ fontSize:14 }}>close</span></button>}
          </div>
        </div>

        {/* Chat history */}
        <div style={{ flex:1, overflowY:"auto", padding:"4px 8px 8px" }}>
          {filtered.length === 0 ? (
            <div style={{ textAlign:"center", color:"var(--outline)", fontSize:13, padding:"28px 16px" }}>
              {chats.length === 0 ? "No chats yet" : "No results"}
            </div>
          ) : (
            <>
              <div className="sb-section-label">Recents</div>
              {filtered.map(chat => (
                <div key={chat.id} className={`chat-row${chat.id===activeChatId ? " active" : ""}`}
                  onClick={() => { onSelectChat(chat.id); onClose(); }}>
                  {renamingId === chat.id ? (
                    <input ref={renameRef} className="rename-input" value={renameVal}
                      onChange={e => setRenameVal(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={e => { if(e.key==="Enter") commitRename(); if(e.key==="Escape") setRenamingId(null); }}
                      onClick={e => e.stopPropagation()} />
                  ) : (
                    <span className="chat-row-text">{chat.title || chatPreview(chat.messages)}</span>
                  )}
                  <button className="chat-row-menu" onClick={e => openCtx(e, chat.id)}
                    style={{ color:"var(--outline)", display:"flex", alignItems:"center", padding:"2px 3px", borderRadius:5, flexShrink:0 }}
                    onMouseEnter={e => { e.currentTarget.style.background="rgba(255,255,255,0.1)"; e.currentTarget.style.color="var(--primary)"; }}
                    onMouseLeave={e => { e.currentTarget.style.background="none"; e.currentTarget.style.color="var(--outline)"; }}>
                    <span className="mso" style={{ fontSize:16 }}>more_horiz</span>
                  </button>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Bottom: user row — exact Claude style */}
        <div style={{ borderTop:"1px solid var(--border)", padding:"10px 10px 12px", flexShrink:0 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10, padding:"6px 8px", borderRadius:9 }}>
            {/* Avatar */}
            <div style={{ position:"relative", flexShrink:0 }}>
              <div style={{ width:32, height:32, borderRadius:"50%", background:"linear-gradient(135deg,#cc785c,#b8622a)", display:"flex", alignItems:"center", justifyContent:"center" }}>
                <span style={{ fontSize:14, fontWeight:700, color:"#fff" }}>{initials}</span>
              </div>
              <div style={{ position:"absolute", bottom:0, right:0, width:9, height:9, borderRadius:"50%", background:agentReady ? "var(--success)" : "var(--outline)", border:"1.5px solid var(--surface)", boxShadow:agentReady ? "0 0 6px rgba(52,211,153,0.7)" : "none" }} />
            </div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:13.5, fontWeight:600, color:"var(--primary)", lineHeight:1.2 }}>Aeython RAG</div>
              <div style={{ fontSize:11.5, color:"var(--outline)" }}>{agentReady ? "Agent online" : "Agent offline"}</div>
            </div>
            {/* Flush icon */}
            <button onClick={onFlush} title="Flush knowledge base"
              style={{ width:28, height:28, borderRadius:6, display:"flex", alignItems:"center", justifyContent:"center", color:"var(--outline)", background:"none", border:"none", cursor:"pointer", transition:"all 0.13s", flexShrink:0 }}
              onMouseEnter={e => { e.currentTarget.style.background="rgba(248,113,113,0.1)"; e.currentTarget.style.color="var(--error)"; }}
              onMouseLeave={e => { e.currentTarget.style.background="none"; e.currentTarget.style.color="var(--outline)"; }}>
              <span className="mso" style={{ fontSize:17 }}>delete_sweep</span>
            </button>
          </div>
        </div>
      </div>

      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)}
          items={[
            { icon:"edit", label:"Rename", action:() => startRename(ctxMenu.chatId, chats.find(c=>c.id===ctxMenu.chatId)?.title||"") },
            { icon:"delete", label:"Delete", danger:true, action:() => onDeleteChat(ctxMenu.chatId) },
          ]}
        />
      )}
    </>
  );
}

// ─── Chat Area ────────────────────────────────────────────────────────────────
function ChatArea({ agentReady, messages, setMessages, onSidebarOpen, uploadedFiles, setUploadedFiles }) {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState("stream");
  const [busy, setBusy] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState(null);
  const [ingestionJob, setIngestionJob] = useState(null);
  const bottomRef = useRef(null);
  const textRef = useRef(null);
  const cancelRef = useRef(null);
  const attachRef = useRef(null);
  const mainRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior:"smooth" }); }, [messages]);
  useEffect(() => {
    if (!showAttach) return;
    const h = (e) => { if (!attachRef.current?.contains(e.target)) setShowAttach(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showAttach]);

  const showToast = (msg, type="success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), type==="error" ? 4000 : 2500);
  };

  const ingestFiles = async (files) => {
    const allNames = files.map(f=>f.name).join(", ");
    setIngestionJob({ fileNames:allNames.length>40 ? allNames.slice(0,40)+"…" : allNames, estimatedSeconds:estimateSeconds(files), completed:false });
    setUploadedFiles(prev => [...prev, ...files.map(f=>({ name:f.name, size:f.size }))]);
    try {
      const csvFiles = files.filter(f=>f.name.toLowerCase().endsWith(".csv"));
      const docFiles = files.filter(f=>!f.name.toLowerCase().endsWith(".csv"));
      let nodeCount = 0;
      if (docFiles.length) { const res = await uploadDocuments(docFiles); nodeCount += res.count||0; }
      for (const csv of csvFiles) await uploadCSV(csv);
      setIngestionJob(j => j ? { ...j, completed:true, nodeCount } : null);
      setTimeout(() => setIngestionJob(null), 5000);
    } catch (err) { setIngestionJob(null); showToast(err.message, "error"); }
  };

  const send = async () => {
    const q = input.trim();
    if (!q || busy || !agentReady) return;
    setInput(""); if (textRef.current) textRef.current.style.height = "auto";
    setBusy(true);
    setMessages(prev => [...prev, { id:Date.now(), role:"user", content:q, ts:ts() }]);
    if (mode === "stream") {
      const agentId = Date.now()+1;
      setMessages(prev => [...prev, { id:agentId, role:"agent", content:"", streaming:true, ts:ts() }]);
      let buf = "";
      cancelRef.current = chatStream(q,
        (tok) => { buf += tok; setMessages(prev => prev.map(m => m.id===agentId ? { ...m, content:buf, streaming:true } : m)); },
        () => { setMessages(prev => prev.map(m => m.id===agentId ? { ...m, streaming:false } : m)); setBusy(false); },
        (err) => { setMessages(prev => prev.map(m => m.id===agentId ? { id:agentId, role:"error", content:err, ts:ts() } : m)); setBusy(false); }
      );
    } else {
      const thinkId = Date.now()+1;
      setMessages(prev => [...prev, { id:thinkId, role:"thinking", ts:ts() }]);
      try {
        const res = await chatFull(q);
        setMessages(prev => prev.map(m => m.id===thinkId ? { id:thinkId, role:"agent", content:res.response, ts:ts() } : m));
      } catch (e) { setMessages(prev => prev.map(m => m.id===thinkId ? { id:thinkId, role:"error", content:e.message, ts:ts() } : m)); }
      setBusy(false);
    }
  };

  const handleKey = (e) => { if (e.key==="Enter" && !e.shiftKey) { e.preventDefault(); send(); } };
  const handleInput = (e) => { setInput(e.target.value); e.target.style.height="auto"; e.target.style.height=Math.min(e.target.scrollHeight,160)+"px"; };
  const isEmpty = messages.length === 0;

  return (
    <main ref={mainRef} style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", position:"relative" }}
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={e => { if (!mainRef.current?.contains(e.relatedTarget)) setDragging(false); }}
      onDrop={async e => { e.preventDefault(); setDragging(false); const f=Array.from(e.dataTransfer.files); if(f.length) await ingestFiles(f); }}>

      {dragging && (
        <div style={{ position:"absolute", inset:0, zIndex:50, background:"rgba(255,255,255,0.02)", border:"2px dashed rgba(255,255,255,0.15)", display:"flex", alignItems:"center", justifyContent:"center", pointerEvents:"none" }}>
          <div style={{ textAlign:"center", color:"var(--primary)" }}>
            <span className="mso" style={{ fontSize:48, display:"block", marginBottom:12, opacity:0.5 }}>upload_file</span>
            <div style={{ fontSize:18, fontWeight:600 }}>Drop files to upload</div>
            <div style={{ fontSize:13, color:"var(--outline)", marginTop:4 }}>PDF, DOCX, MD, TXT, CSV</div>
          </div>
        </div>
      )}

      <Toast toast={toast} onDismiss={() => setToast(null)} />
      <IngestionProgress job={ingestionJob} onDismiss={() => setIngestionJob(null)} />

      {/* Top bar */}
      <header style={{ display:"flex", alignItems:"center", height:"var(--topbar-h)", padding:"0 16px", flexShrink:0, gap:10, borderBottom:"1px solid var(--border)", background:"var(--bg)" }}>
        <div style={{ flex:1 }} />
        <div style={{ display:"flex", gap:2, background:"rgba(255,255,255,0.04)", border:"1px solid var(--border)", borderRadius:9, padding:"3px" }}>
          {["stream","full"].map(m => (
            <button key={m} onClick={() => setMode(m)} style={{ fontSize:11.5, padding:"4px 14px", borderRadius:6, border:"none", color:mode===m ? "var(--primary)" : "var(--outline)", background:mode===m ? "rgba(255,255,255,0.09)" : "transparent", fontWeight:mode===m ? 600 : 400, transition:"all 0.14s", cursor:"pointer" }}>
              {m==="stream" ? "Stream" : "Full"}
            </button>
          ))}
        </div>
      </header>

      {/* Messages */}
      <div style={{ flex:1, overflowY:"auto", padding:isEmpty ? "0" : "28px 40px 140px" }}>
        {isEmpty ? (
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", minHeight:"calc(100vh - var(--topbar-h) - 110px)", gap:40, padding:"40px 40px 140px" }}>
            <div style={{ textAlign:"center" }}>
              <span className="mso" style={{ fontSize:52, color:"var(--primary)", opacity:0.45, display:"block", marginBottom:20, fontVariationSettings:"'FILL' 0,'wght' 200" }}>all_inclusive</span>
              <h1 style={{ fontSize:36, fontWeight:700, color:"var(--primary)", letterSpacing:"-0.025em", marginBottom:10, lineHeight:1.1 }}>How can I help?</h1>
              <p style={{ fontSize:14, color:"var(--outline)", fontWeight:400 }}>Intelligence at the speed of thought.</p>
            </div>
            <div style={{ maxWidth:580, width:"100%" }}>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10 }}>
                {SUGGESTIONS.map((s,i) => (
                  <button key={i} onClick={() => { setInput(s.label); textRef.current?.focus(); }}
                    style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:14, padding:"16px 10px", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:10, transition:"all 0.14s", cursor:"pointer" }}
                    onMouseEnter={e => { e.currentTarget.style.background="rgba(255,255,255,0.06)"; e.currentTarget.style.borderColor="rgba(255,255,255,0.13)"; }}
                    onMouseLeave={e => { e.currentTarget.style.background="rgba(255,255,255,0.03)"; e.currentTarget.style.borderColor="rgba(255,255,255,0.07)"; }}>
                    <span className="mso" style={{ fontSize:22, color:"rgba(255,255,255,0.35)" }}>{s.icon}</span>
                    <span style={{ fontSize:10, fontWeight:700, color:"var(--on-surface-var)", textTransform:"uppercase", letterSpacing:"0.07em", textAlign:"center" }}>{s.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ maxWidth:720, margin:"0 auto" }}>
            {messages.map(msg => <MessageBubble key={msg.id} msg={msg} />)}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Input bar */}
      <div style={{ position:"absolute", bottom:24, left:24, right:24, display:"flex", justifyContent:"center" }}>
        <div style={{ width:"100%", maxWidth:740 }}>
          <div style={{ background:"rgba(255,255,255,0.03)", backdropFilter:"blur(20px)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:20, boxShadow:"0 8px 40px rgba(0,0,0,0.5)" }}>
            <div style={{ display:"flex", alignItems:"center", padding:"12px 16px 6px" }}>
              <textarea ref={textRef} value={input} onChange={handleInput} onKeyDown={handleKey}
                disabled={busy||!agentReady}
                placeholder={agentReady ? "What do you want to know?" : "Waiting for agent…"}
                rows={1}
                style={{ flex:1, background:"transparent", border:"none", outline:"none", resize:"none", fontSize:15, color:"var(--primary)", lineHeight:1.6, minHeight:28, maxHeight:160, overflowY:"auto", caretColor:"var(--primary)", fontFamily:"var(--sans)" }}
              />
            </div>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"4px 10px 10px" }}>
              <div>{input.length>100 && <span style={{ fontSize:11, color:input.length>400?"var(--warn)":"var(--outline)", padding:"0 6px" }}>{input.length}</span>}</div>
              <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                <div ref={attachRef} style={{ position:"relative" }}>
                  <button onClick={() => setShowAttach(v=>!v)}
                    style={{ padding:8, color:showAttach?"var(--primary)":"var(--on-surface-var)", borderRadius:9, transition:"all 0.15s", display:"flex", alignItems:"center", background:showAttach?"rgba(255,255,255,0.07)":"none" }}
                    onMouseEnter={e => { if(!showAttach) e.currentTarget.style.color="var(--primary)"; }}
                    onMouseLeave={e => { if(!showAttach) e.currentTarget.style.color="var(--on-surface-var)"; }}>
                    <span className="mso" style={{ fontSize:22, transform:showAttach?"rotate(45deg)":"none", transition:"transform 0.2s" }}>attachment</span>
                  </button>
                  {showAttach && <AttachDropup onClose={() => setShowAttach(false)} onIngest={ingestFiles} />}
                </div>
                <button onClick={send} disabled={busy||!agentReady||!input.trim()}
                  style={{ width:38, height:38, borderRadius:12, background:(busy||!input.trim())?"rgba(255,255,255,0.06)":"var(--primary)", border:"none", display:"flex", alignItems:"center", justifyContent:"center", color:(busy||!input.trim())?"var(--outline)":"#000", transition:"all 0.15s", cursor:busy?"not-allowed":"pointer", boxShadow:(!busy&&input.trim())?"0 2px 16px rgba(255,255,255,0.18)":"none" }}>
                  {busy
                    ? <span className="mso" style={{ fontSize:18, animation:"spin 1s linear infinite", display:"inline-block" }}>refresh</span>
                    : <span className="mso" style={{ fontSize:18, fontVariationSettings:"'FILL' 1,'wght' 600" }}>arrow_upward</span>
                  }
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

// ─── App Root ─────────────────────────────────────────────────────────────────
export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [agentReady, setAgentReady] = useState(false);
  const [flushPhase, setFlushPhase] = useState(null);
  const [appToast, setAppToast] = useState(null);
  const prevAgentReady = useRef(null);
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [uploadedFiles, setUploadedFiles] = useState([]);

  const activeChat = chats.find(c => c.id === activeChatId);
  const messages = activeChat?.messages || [];

  const setMessages = useCallback((updater) => {
    setChats(prev => prev.map(c => {
      if (c.id !== activeChatId) return c;
      const next = typeof updater==="function" ? updater(c.messages) : updater;
      return { ...c, messages:next };
    }));
  }, [activeChatId]);

  useEffect(() => {
    if (chats.length===0) {
      const id = genId();
      setChats([{ id, title:"", messages:[] }]);
      setActiveChatId(id);
    } else if (!activeChatId || !chats.find(c=>c.id===activeChatId)) {
      setActiveChatId(chats[0].id);
    }
  }, [chats, activeChatId]);

  const showAppToast = useCallback((msg, type="info") => {
    setAppToast({ msg, type });
    setTimeout(() => setAppToast(null), type==="error" ? 4000 : 3000);
  }, []);

  useEffect(() => {
    const poll = async () => {
      try {
        const d = await checkHealth();
        const ready = !!d.agent_ready;
        setAgentReady(ready);
        if (prevAgentReady.current!==null && prevAgentReady.current!==ready)
          showAppToast(ready ? "Agent is online" : "Agent went offline", ready ? "success" : "warn");
        prevAgentReady.current = ready;
      } catch {
        setAgentReady(false);
        if (prevAgentReady.current!==false) showAppToast("Cannot reach backend","error");
        prevAgentReady.current = false;
      }
    };
    poll();
    const id = setInterval(poll, 30000);
    return () => clearInterval(id);
  }, [showAppToast]);

  const handleNewChat = () => {
    const id = genId();
    setChats(prev => [{ id, title:"", messages:[] }, ...prev]);
    setActiveChatId(id);
    setSidebarOpen(false);
  };
  const handleSelectChat = (id) => { setActiveChatId(id); };
  const handleDeleteChat = (id) => {
    setChats(prev => {
      const next = prev.filter(c=>c.id!==id);
      if (next.length===0) { const newId=genId(); return [{ id:newId, title:"", messages:[] }]; }
      return next;
    });
    if (activeChatId===id) {
      const remaining = chats.filter(c=>c.id!==id);
      if (remaining.length>0) setActiveChatId(remaining[0].id);
    }
  };
  const handleRenameChat = (id, newTitle) => {
    setChats(prev => prev.map(c => c.id===id ? { ...c, title:newTitle } : c));
  };
  const handleFlushConfirm = async () => {
    setFlushPhase("flushing");
    try {
      await flushAll();
      try { await resetMemory(); } catch {}
      setMessages([]);
      setUploadedFiles([]);
      setFlushPhase("done");
    } catch (e) { setFlushPhase(null); showAppToast("Flush failed: "+e.message,"error"); }
  };

  return (
    <>
      <style>{STYLES}</style>
      <Sidebar
        open={sidebarOpen}
        onOpen={() => setSidebarOpen(true)}
        onClose={() => setSidebarOpen(false)}
        agentReady={agentReady}
        chats={chats}
        activeChatId={activeChatId}
        onSelectChat={handleSelectChat}
        onNewChat={handleNewChat}
        onDeleteChat={handleDeleteChat}
        onRenameChat={handleRenameChat}
        uploadedFiles={uploadedFiles}
        onFlush={() => setFlushPhase("confirm")}
      />
      <div className="main-area">
        <ChatArea
          agentReady={agentReady}
          messages={messages}
          setMessages={setMessages}
          onSidebarOpen={() => setSidebarOpen(true)}
          uploadedFiles={uploadedFiles}
          setUploadedFiles={setUploadedFiles}
        />
      </div>
      {flushPhase && <FlushOverlay phase={flushPhase} onConfirm={handleFlushConfirm} onCancel={() => setFlushPhase(null)} />}
      <Toast toast={appToast} onDismiss={() => setAppToast(null)} />
    </>
  );
}