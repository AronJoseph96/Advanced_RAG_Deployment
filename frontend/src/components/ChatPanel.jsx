import { useState, useRef, useEffect, useCallback } from 'react';
import Message from './Message';
import { chatFull, chatStream, resetMemory } from '../api';

function ts() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0')).join(':');
}

const SUGGESTIONS = [
  'What are the main topics in the documents?',
  'Summarise the key findings from the knowledge base.',
  'How many records exist in the structured data?',
  'What does the research say about this subject?',
];

export default function ChatPanel({ agentReady }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput]       = useState('');
  const [mode, setMode]         = useState('stream'); // 'stream' | 'full'
  const [busy, setBusy]         = useState(false);
  const bottomRef  = useRef(null);
  const textRef    = useRef(null);
  const cancelRef  = useRef(null);

  const scrollBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(scrollBottom, [messages]);

  const addMsg = useCallback((msg) => {
    setMessages(prev => [...prev, msg]);
    return msg.id;
  }, []);

  const updateLastAgent = useCallback((updater) => {
    setMessages(prev => {
      const next = [...prev];
      const idx  = next.findLastIndex(m => m.role === 'agent');
      if (idx !== -1) next[idx] = updater(next[idx]);
      return next;
    });
  }, []);

  const send = async () => {
    const q = input.trim();
    if (!q || busy || !agentReady) return;

    setInput('');
    textRef.current.style.height = 'auto';
    setBusy(true);

    // Add user message
    addMsg({ id: Date.now(), role: 'user', content: q, ts: ts() });

    if (mode === 'stream') {
      // Add placeholder agent message
      const agentId = Date.now() + 1;
      setMessages(prev => [...prev, { id: agentId, role: 'agent', content: '', streaming: true, ts: ts() }]);

      let buffer = '';
      cancelRef.current = chatStream(
        q,
        (token) => {
          buffer += token;
          setMessages(prev => {
            const next = [...prev];
            const idx  = next.findLastIndex(m => m.role === 'agent');
            if (idx !== -1) next[idx] = { ...next[idx], content: buffer, streaming: true };
            return next;
          });
        },
        () => {
          setMessages(prev => {
            const next = [...prev];
            const idx  = next.findLastIndex(m => m.role === 'agent');
            if (idx !== -1) next[idx] = { ...next[idx], streaming: false };
            return next;
          });
          setBusy(false);
        },
        (err) => {
          setMessages(prev => {
            const next = [...prev];
            const idx  = next.findLastIndex(m => m.role === 'agent');
            if (idx !== -1) next[idx] = { id: agentId, role: 'error', content: err, ts: ts() };
            return next;
          });
          setBusy(false);
        },
      );
    } else {
      // Full mode — show thinking indicator
      const thinkId = Date.now() + 1;
      setMessages(prev => [...prev, { id: thinkId, role: 'thinking', ts: ts() }]);
      try {
        const res = await chatFull(q);
        setMessages(prev => prev.map(m =>
          m.id === thinkId
            ? { id: thinkId, role: 'agent', content: res.response, ts: ts() }
            : m
        ));
      } catch (e) {
        setMessages(prev => prev.map(m =>
          m.id === thinkId
            ? { id: thinkId, role: 'error', content: e.message, ts: ts() }
            : m
        ));
      }
      setBusy(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const handleInput = (e) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
  };

  const handleReset = async () => {
    if (!confirm('Clear conversation memory and history?')) return;
    if (cancelRef.current) cancelRef.current();
    try { await resetMemory(); } catch {}
    setMessages([]);
    setBusy(false);
  };

  const isEmpty = messages.length === 0;

  return (
    <div style={{
      flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0,
    }}>
      {/* Top bar */}
      <div style={{
        display:'flex', alignItems:'center', justifyContent:'space-between',
        padding:'0 20px', height:48,
        borderBottom:'1px solid var(--border)',
        background:'var(--surface)',
        flexShrink:0,
      }}>
        <span style={{ fontFamily:'var(--display)', fontSize:12, letterSpacing:'0.12em', color:'var(--text-dim)' }}>
          CHAT INTERFACE
        </span>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          {/* Mode toggle */}
          {['stream','full'].map(m => (
            <button key={m} onClick={() => setMode(m)} style={{
              fontFamily:'var(--mono)', fontSize:10, letterSpacing:'0.08em',
              padding:'3px 10px', cursor:'pointer',
              border: `1px solid ${mode===m ? 'var(--accent)' : 'var(--border2)'}`,
              color: mode===m ? 'var(--accent)' : 'var(--text-dim)',
              background: mode===m ? 'var(--accent-dim)' : 'transparent',
              transition:'all 0.15s',
            }}>
              {m.toUpperCase()}
            </button>
          ))}
          <button onClick={handleReset} style={{
            fontFamily:'var(--mono)', fontSize:10, letterSpacing:'0.08em',
            padding:'3px 10px', cursor:'pointer',
            border:'1px solid var(--border2)',
            color:'var(--text-dim)', background:'transparent',
            transition:'all 0.15s',
          }}
          onMouseEnter={e => { e.target.style.color='var(--warn)'; e.target.style.borderColor='var(--warn)'; }}
          onMouseLeave={e => { e.target.style.color='var(--text-dim)'; e.target.style.borderColor='var(--border2)'; }}
          >
            RESET
          </button>
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex:1, overflowY:'auto', display:'flex', flexDirection:'column' }}>

        {/* Empty state */}
        {isEmpty && (
          <div style={{
            flex:1, display:'flex', flexDirection:'column',
            alignItems:'center', justifyContent:'center',
            padding:40, gap:20, color:'var(--text-dim)',
          }}>
            <div style={{ fontFamily:'var(--display)', fontSize:22, letterSpacing:'0.1em', color:'var(--text)' }}>
              <span style={{ color:'var(--accent)' }}>&gt;</span> READY
            </div>
            <div style={{ fontSize:11, letterSpacing:'0.06em' }}>
              upload documents · then query the knowledge base
            </div>
            <div style={{
              display:'grid', gridTemplateColumns:'1fr 1fr',
              gap:1, background:'var(--border)', border:'1px solid var(--border)',
              maxWidth:480, width:'100%',
            }}>
              {SUGGESTIONS.map((s, i) => (
                <button key={i} onClick={() => { setInput(s); textRef.current?.focus(); }}
                  style={{
                    background:'var(--surface)', padding:'12px 14px',
                    border:'none', textAlign:'left', cursor:'pointer',
                    fontFamily:'var(--mono)', fontSize:11, color:'var(--text-dim)',
                    lineHeight:1.5, transition:'background 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background='var(--surface2)'; e.currentTarget.style.color='var(--text)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background='var(--surface)'; e.currentTarget.style.color='var(--text-dim)'; }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map(msg => <Message key={msg.id} msg={msg} />)}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{
        borderTop:'1px solid var(--border)',
        background:'var(--surface)',
        padding:'14px 20px',
        flexShrink:0,
      }}>
        <div style={{ display:'flex', gap:10, alignItems:'flex-end' }}>
          {/* Textarea wrapper */}
          <div style={{
            flex:1, position:'relative',
            border:`1px solid ${busy ? 'var(--accent)' : 'var(--border2)'}`,
            background:'var(--bg)',
            transition:'border-color 0.2s',
          }}>
            <span style={{
              position:'absolute', left:12, top:11,
              fontFamily:'var(--mono)', fontSize:13, color:'var(--accent)',
              pointerEvents:'none', userSelect:'none',
            }}>›</span>
            <textarea
              ref={textRef}
              value={input}
              onChange={handleInput}
              onKeyDown={handleKey}
              disabled={busy || !agentReady}
              placeholder={agentReady ? 'Ask anything about your documents…' : 'Waiting for agent…'}
              rows={1}
              style={{
                width:'100%', background:'transparent',
                border:'none', outline:'none',
                color:'var(--text)', fontFamily:'var(--mono)', fontSize:13,
                lineHeight:1.6, padding:'10px 12px 10px 28px',
                resize:'none', minHeight:42, maxHeight:160,
                overflowY:'auto',
              }}
            />
          </div>

          {/* Send button */}
          <button
            onClick={send}
            disabled={busy || !agentReady || !input.trim()}
            style={{
              width:42, height:42, flexShrink:0,
              background: busy ? 'var(--surface2)' : 'var(--accent)',
              border:'none', cursor: busy ? 'not-allowed' : 'pointer',
              display:'flex', alignItems:'center', justifyContent:'center',
              color: busy ? 'var(--text-dim)' : '#000',
              transition:'background 0.15s',
              fontSize:16,
            }}
            onMouseEnter={e => { if (!busy) e.currentTarget.style.background='#00ffcc'; }}
            onMouseLeave={e => { if (!busy) e.currentTarget.style.background='var(--accent)'; }}
          >
            {busy ? '…' : '↑'}
          </button>
        </div>

        <div style={{
          display:'flex', justifyContent:'space-between',
          marginTop:8, fontSize:10, color:'var(--text-dim)', letterSpacing:'0.04em',
        }}>
          <span>↵ send &nbsp;·&nbsp; shift+↵ newline &nbsp;·&nbsp; mode: <span style={{color:'var(--accent)'}}>{mode === 'stream' ? 'streaming SSE' : 'full JSON'}</span></span>
          <span style={{color: input.length > 400 ? 'var(--warn)' : 'var(--text-dim)'}}>
            {input.length} chars
          </span>
        </div>
      </div>
    </div>
  );
}