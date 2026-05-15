import { useState, useRef, useEffect, useCallback } from 'react';
import Message from './Message';
import { chatFull, chatStream, resetMemory, uploadDocuments, uploadCSV } from '../api';

function ts() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0')).join(':');
}

const SUGGESTIONS = [
  { icon: '⟡', text: 'What are the main topics in the indexed documents?' },
  { icon: '◈', text: 'Summarise the key findings from the knowledge base.' },
  { icon: '⊞', text: 'How many records exist in the structured data?' },
  { icon: '◉', text: 'What does the research say about this subject?' },
];

// Pin / attachment popup
function AttachPopup({ onClose, onUploadDocs, onUploadCSV }) {
  const docsRef = useRef();
  const csvRef = useRef();
  return (
    <div style={{
      position: 'absolute', bottom: '100%', left: 0, marginBottom: 10,
      background: 'var(--surface2)', border: '1px solid var(--border2)',
      borderRadius: 10, padding: '6px 0', width: 210, zIndex: 50,
      boxShadow: '0 8px 30px rgba(0,0,0,0.4)',
      animation: 'fadeUp 0.15s ease',
    }}>
      <div style={{
        padding: '4px 14px 8px',
        fontSize: 10, letterSpacing: '0.1em', color: 'var(--text-dim)',
        borderBottom: '1px solid var(--border)', marginBottom: 4,
        fontFamily: 'var(--display)', fontWeight: 700,
      }}>ATTACH FILE</div>

      <button onClick={() => docsRef.current.click()} style={{
        width: '100%', background: 'none', border: 'none',
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 14px', color: 'var(--text)', fontSize: 12,
        textAlign: 'left', transition: 'background 0.12s',
      }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--violet-dim)'}
        onMouseLeave={e => e.currentTarget.style.background = 'none'}
      >
        <span style={{ color: 'var(--violet)', fontSize: 15 }}>◈</span>
        <div>
          <div style={{ fontWeight: 500 }}>Documents</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>PDF, DOCX, MD, TXT → Pinecone</div>
        </div>
      </button>
      <input ref={docsRef} type="file" accept=".pdf,.docx,.md,.txt" multiple
        style={{ display: 'none' }}
        onChange={e => { onUploadDocs(Array.from(e.target.files)); onClose(); }} />

      <button onClick={() => csvRef.current.click()} style={{
        width: '100%', background: 'none', border: 'none',
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 14px', color: 'var(--text)', fontSize: 12,
        textAlign: 'left', transition: 'background 0.12s',
      }}
        onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,181,173,0.1)'}
        onMouseLeave={e => e.currentTarget.style.background = 'none'}
      >
        <span style={{ color: 'var(--teal)', fontSize: 15 }}>⊞</span>
        <div>
          <div style={{ fontWeight: 500 }}>Structured CSV</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>CSV → SQLite (NL→SQL)</div>
        </div>
      </button>
      <input ref={csvRef} type="file" accept=".csv"
        style={{ display: 'none' }}
        onChange={e => { onUploadCSV(Array.from(e.target.files)); onClose(); }} />
    </div>
  );
}

// Toast notification
function Toast({ toast }) {
  if (!toast) return null;
  const colors = {
    success: { border: 'var(--success)', bg: 'rgba(29,185,84,0.1)', text: 'var(--success)' },
    error: { border: 'var(--error)', bg: 'rgba(239,68,68,0.1)', text: 'var(--error)' },
    info: { border: 'var(--violet)', bg: 'var(--violet-dim)', text: 'var(--violet-light)' },
  };
  const c = colors[toast.type] || colors.info;
  return (
    <div style={{
      position: 'absolute', top: 60, right: 20,
      background: c.bg, border: `1px solid ${c.border}`,
      color: c.text, borderRadius: 8,
      padding: '10px 16px', fontSize: 12, maxWidth: 320,
      animation: 'fadeUp 0.2s ease',
      zIndex: 100,
    }}>
      {toast.msg}
    </div>
  );
}

export default function ChatPanel({ agentReady }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState('stream');
  const [busy, setBusy] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [toast, setToast] = useState(null);
  const [chatDragging, setChatDragging] = useState(false);

  const bottomRef = useRef(null);
  const textRef = useRef(null);
  const cancelRef = useRef(null);
  const panelRef = useRef(null);

  const showToast = (msg, type = 'info', duration = 3500) => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), duration);
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Close attach popup on outside click
  useEffect(() => {
    if (!showAttach) return;
    const handler = (e) => {
      if (!e.target.closest('[data-attach]')) setShowAttach(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showAttach]);

  const ingestFiles = async (files) => {
    const docs = files.filter(f => /\.(pdf|docx|md|txt)$/i.test(f.name));
    const csvs = files.filter(f => /\.csv$/i.test(f.name));

    const tasks = [];
    if (docs.length) tasks.push(uploadDocuments(docs).then(r => `${r.count || 0} nodes indexed from ${docs.length} doc(s)`));
    if (csvs.length) tasks.push(uploadCSV(csvs[0]).then(r => r.message || 'CSV loaded'));

    if (!tasks.length) {
      showToast('Unsupported file type. Use PDF, DOCX, MD, TXT or CSV.', 'error');
      return;
    }

    showToast('Uploading & indexing…', 'info');
    try {
      const results = await Promise.all(tasks);
      showToast(results.join(' · '), 'success');
    } catch (e) {
      showToast(e.message, 'error');
    }
  };

  // Drag-drop onto chat panel
  const handlePanelDrop = async (e) => {
    e.preventDefault(); setChatDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) await ingestFiles(files);
  };

  const send = async (overrideQuery) => {
    const q = (overrideQuery || input).trim();
    if (!q || busy || !agentReady) return;

    setInput('');
    if (textRef.current) textRef.current.style.height = 'auto';
    setBusy(true);
    setShowAttach(false);

    setMessages(prev => [...prev, { id: Date.now(), role: 'user', content: q, ts: ts() }]);

    if (mode === 'stream') {
      const agentId = Date.now() + 1;
      setMessages(prev => [...prev, { id: agentId, role: 'agent', content: '', streaming: true, ts: ts() }]);

      let buffer = '';
      cancelRef.current = chatStream(q,
        (token) => {
          buffer += token;
          setMessages(prev => {
            const next = [...prev];
            const idx = next.findLastIndex(m => m.role === 'agent');
            if (idx !== -1) next[idx] = { ...next[idx], content: buffer, streaming: true };
            return next;
          });
        },
        () => {
          setMessages(prev => {
            const next = [...prev];
            const idx = next.findLastIndex(m => m.role === 'agent');
            if (idx !== -1) next[idx] = { ...next[idx], streaming: false };
            return next;
          });
          setBusy(false);
        },
        (err) => {
          setMessages(prev => {
            const next = [...prev];
            const idx = next.findLastIndex(m => m.role === 'agent');
            if (idx !== -1) next[idx] = { id: agentId, role: 'error', content: err, ts: ts() };
            return next;
          });
          setBusy(false);
        }
      );
    } else {
      const thinkId = Date.now() + 1;
      setMessages(prev => [...prev, { id: thinkId, role: 'thinking', ts: ts() }]);
      try {
        const res = await chatFull(q);
        setMessages(prev => prev.map(m =>
          m.id === thinkId ? { id: thinkId, role: 'agent', content: res.response, ts: ts() } : m
        ));
      } catch (e) {
        setMessages(prev => prev.map(m =>
          m.id === thinkId ? { id: thinkId, role: 'error', content: e.message, ts: ts() } : m
        ));
      }
      setBusy(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const handleTextInput = (e) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
  };

  const handleReset = async () => {
    if (!confirm('Clear conversation history?')) return;
    if (cancelRef.current) cancelRef.current();
    try { await resetMemory(); } catch { }
    setMessages([]); setBusy(false);
  };

  return (
    <div
      ref={panelRef}
      style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, position: 'relative' }}
      onDragOver={e => { e.preventDefault(); setChatDragging(true); }}
      onDragLeave={e => { if (!panelRef.current?.contains(e.relatedTarget)) setChatDragging(false); }}
      onDrop={handlePanelDrop}
    >
      {/* Drag-over overlay */}
      {chatDragging && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 40,
          background: 'rgba(145,71,255,0.08)',
          border: '2px dashed var(--violet)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
        }}>
          <div style={{
            textAlign: 'center', color: 'var(--violet)',
            fontFamily: 'var(--display)', fontSize: 18, fontWeight: 700,
          }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>📎</div>
            Drop to ingest into knowledge base
          </div>
        </div>
      )}

      <Toast toast={toast} />

      {/* Top bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 20px', height: 48,
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface)', flexShrink: 0,
      }}>
        <span style={{
          fontFamily: 'var(--display)', fontSize: 11,
          letterSpacing: '0.12em', color: 'var(--text-dim)', fontWeight: 700,
        }}>
          CHAT INTERFACE
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {['stream', 'full'].map(m => (
            <button key={m} onClick={() => setMode(m)} style={{
              fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.06em',
              padding: '3px 10px', cursor: 'pointer', borderRadius: 5,
              border: `1px solid ${mode === m ? 'var(--violet)' : 'var(--border2)'}`,
              color: mode === m ? 'var(--violet)' : 'var(--text-dim)',
              background: mode === m ? 'var(--violet-dim)' : 'transparent',
              transition: 'all 0.15s',
            }}>
              {m === 'stream' ? 'STREAM' : 'FULL'}
            </button>
          ))}
          <button onClick={handleReset} style={{
            fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.06em',
            padding: '3px 10px', cursor: 'pointer', borderRadius: 5,
            border: '1px solid var(--border2)', color: 'var(--text-dim)',
            background: 'transparent', transition: 'all 0.15s',
          }}
            onMouseEnter={e => { e.target.style.color = 'var(--error)'; e.target.style.borderColor = 'var(--error)'; }}
            onMouseLeave={e => { e.target.style.color = 'var(--text-dim)'; e.target.style.borderColor = 'var(--border2)'; }}
          >
            RESET
          </button>
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        {messages.length === 0 && (
          <div style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            padding: 40, gap: 24,
          }}>
            {/* Logo orb */}
            <div style={{
              width: 72, height: 72, borderRadius: '50%',
              background: 'var(--violet-dim)',
              border: '1px solid var(--violet-mid)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 28,
            }}>
              <span style={{ color: 'var(--violet)' }}>⟡</span>
            </div>

            <div style={{ textAlign: 'center' }}>
              <div style={{
                fontFamily: 'var(--display)', fontSize: 26,
                fontWeight: 800, letterSpacing: '0.02em', color: 'var(--text)',
              }}>
                How can I assist you?
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>
                Upload documents · query the knowledge base
              </div>
            </div>

            {/* Suggestion grid */}
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr',
              gap: 8, maxWidth: 500, width: '100%',
            }}>
              {SUGGESTIONS.map((s, i) => (
                <button key={i}
                  onClick={() => { setInput(s.text); textRef.current?.focus(); }}
                  style={{
                    background: 'var(--surface)', padding: '12px 14px',
                    border: '1px solid var(--border)', borderRadius: 10,
                    textAlign: 'left', cursor: 'pointer',
                    fontFamily: 'var(--mono)', fontSize: 11,
                    color: 'var(--text-dim)', lineHeight: 1.5,
                    transition: 'all 0.15s', display: 'flex', gap: 8,
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.background = 'var(--violet-dim)';
                    e.currentTarget.style.borderColor = 'var(--violet)';
                    e.currentTarget.style.color = 'var(--text)';
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.background = 'var(--surface)';
                    e.currentTarget.style.borderColor = 'var(--border)';
                    e.currentTarget.style.color = 'var(--text-dim)';
                  }}
                >
                  <span style={{ color: 'var(--violet)', flexShrink: 0 }}>{s.icon}</span>
                  {s.text}
                </button>
              ))}
            </div>

            <div style={{
              fontSize: 10, color: 'var(--text-dim)', marginTop: -8,
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <span>📎</span> Drag &amp; drop files anywhere in this panel to ingest them
            </div>
          </div>
        )}

        {messages.map(msg => <Message key={msg.id} msg={msg} />)}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div style={{
        borderTop: '1px solid var(--border)',
        background: 'var(--surface)',
        padding: '14px 20px', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', position: 'relative' }}>

          {/* Pin / attach button */}
          <div data-attach style={{ position: 'relative', flexShrink: 0 }}>
            <button
              onClick={() => setShowAttach(p => !p)}
              title="Attach file"
              style={{
                width: 42, height: 42, borderRadius: 8, flexShrink: 0,
                background: showAttach ? 'var(--violet-dim)' : 'var(--surface2)',
                border: `1px solid ${showAttach ? 'var(--violet)' : 'var(--border2)'}`,
                color: showAttach ? 'var(--violet)' : 'var(--text-dim)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 18, transition: 'all 0.15s',
                transform: showAttach ? 'rotate(45deg)' : 'none',
              }}
              onMouseEnter={e => { if (!showAttach) { e.currentTarget.style.borderColor = 'var(--violet)'; e.currentTarget.style.color = 'var(--violet)'; } }}
              onMouseLeave={e => { if (!showAttach) { e.currentTarget.style.borderColor = 'var(--border2)'; e.currentTarget.style.color = 'var(--text-dim)'; } }}
            >
              📌
            </button>

            {showAttach && (
              <AttachPopup
                onClose={() => setShowAttach(false)}
                onUploadDocs={(files) => ingestFiles(files)}
                onUploadCSV={(files) => ingestFiles(files)}
              />
            )}
          </div>

          {/* Textarea */}
          <div style={{
            flex: 1, position: 'relative',
            border: `1px solid ${busy ? 'var(--violet)' : 'var(--border2)'}`,
            background: 'var(--bg)', borderRadius: 8,
            transition: 'border-color 0.2s',
          }}>
            <span style={{
              position: 'absolute', left: 12, top: 11,
              fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--violet)',
              pointerEvents: 'none', userSelect: 'none',
            }}>›</span>
            <textarea
              ref={textRef}
              value={input}
              onChange={handleTextInput}
              onKeyDown={handleKey}
              disabled={busy || !agentReady}
              placeholder={agentReady ? 'Ask anything about your documents…' : 'Waiting for agent to be ready…'}
              rows={1}
              style={{
                width: '100%', background: 'transparent',
                border: 'none', outline: 'none',
                color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 13,
                lineHeight: 1.6, padding: '10px 12px 10px 28px',
                resize: 'none', minHeight: 42, maxHeight: 160, overflowY: 'auto',
              }}
            />
          </div>

          {/* Send */}
          <button
            onClick={() => send()}
            disabled={busy || !agentReady || !input.trim()}
            style={{
              width: 42, height: 42, flexShrink: 0, borderRadius: 8,
              background: (busy || !input.trim()) ? 'var(--surface2)' : 'var(--violet)',
              border: 'none',
              cursor: busy ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: (busy || !input.trim()) ? 'var(--text-dim)' : '#fff',
              fontSize: 18, transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={e => { if (!busy && input.trim()) e.currentTarget.style.background = '#7c2fee'; }}
            onMouseLeave={e => { if (!busy && input.trim()) e.currentTarget.style.background = 'var(--violet)'; }}
          >
            {busy ? (
              <span style={{ fontSize: 14, animation: 'spin 1s linear infinite', display: 'inline-block' }}>◌</span>
            ) : '↑'}
          </button>
        </div>

        <div style={{
          display: 'flex', justifyContent: 'space-between',
          marginTop: 8, fontSize: 10, color: 'var(--text-dim)', letterSpacing: '0.03em',
        }}>
          <span>↵ send · shift+↵ newline · mode: <span style={{ color: 'var(--violet)' }}>
            {mode === 'stream' ? 'streaming SSE' : 'full JSON'}
          </span></span>
          <span style={{ color: input.length > 400 ? 'var(--warn)' : 'var(--text-dim)' }}>
            {input.length} chars
          </span>
        </div>
      </div>
    </div>
  );
}