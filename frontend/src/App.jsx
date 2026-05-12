import { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import ChatPanel from './components/ChatPanel';
import { checkHealth } from './api';

function StatusDot({ status }) {
  const colors = { online:'var(--accent)', thinking:'var(--blue)', error:'var(--warn)', offline:'var(--border2)' };
  const color  = colors[status] || colors.offline;
  return (
    <span style={{
      display:'inline-block', width:7, height:7, borderRadius:'50%',
      background:color,
      boxShadow: status === 'online' ? `0 0 6px ${color}` : 'none',
      animation: status === 'thinking' ? 'pulse 1s infinite' : 'none',
    }} />
  );
}

export default function App() {
  const [health, setHealth]   = useState({ status:'offline', agent_ready:false });
  const [connStatus, setConn] = useState('offline');

  const poll = async () => {
    try {
      const d = await checkHealth();
      setHealth(d);
      setConn(d.agent_ready ? 'online' : 'thinking');
    } catch {
      setHealth({ status:'offline', agent_ready:false });
      setConn('offline');
    }
  };

  useEffect(() => {
    poll();
    const id = setInterval(poll, 8000);
    return () => clearInterval(id);
  }, []);

  const statusLabel = {
    online:   'READY',
    thinking: 'INITIALISING',
    offline:  'OFFLINE',
  }[connStatus] || 'OFFLINE';

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh' }}>
      {/* ── Top header ── */}
      <header style={{
        display:'flex', alignItems:'center', justifyContent:'space-between',
        padding:'0 20px', height:52, flexShrink:0,
        background:'var(--surface)',
        borderBottom:'1px solid var(--border)',
      }}>
        {/* Logo */}
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <div style={{
            width:30, height:30,
            border:'2px solid var(--accent)',
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:10, fontWeight:600, color:'var(--accent)', letterSpacing:'-0.5px',
            position:'relative',
          }}>
            <span style={{ position:'relative', zIndex:1 }}>AR</span>
            <span style={{ position:'absolute', inset:4, background:'var(--accent)', opacity:0.12 }} />
          </div>
          <div>
            <div style={{ fontFamily:'var(--display)', fontSize:14, letterSpacing:'0.12em', color:'var(--text)' }}>
              ADV<span style={{color:'var(--accent)'}}>RAG</span>
            </div>
            <div style={{ fontSize:9, letterSpacing:'0.1em', color:'var(--text-dim)', marginTop:-1 }}>
              HYBRID RETRIEVAL SYSTEM
            </div>
          </div>
        </div>

        {/* Status */}
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <StatusDot status={connStatus} />
          <span style={{ fontSize:10, letterSpacing:'0.1em', color:'var(--text-dim)', fontFamily:'var(--mono)' }}>
            {statusLabel}
          </span>
          {connStatus === 'offline' && (
            <span style={{ fontSize:10, color:'var(--warn)', fontFamily:'var(--mono)' }}>
              · start uvicorn on :8000
            </span>
          )}
        </div>

        <style>{`
          @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        `}</style>
      </header>

      {/* ── Body ── */}
      <div style={{ display:'flex', flex:1, overflow:'hidden' }}>
        <Sidebar agentReady={health.agent_ready} />
        <ChatPanel agentReady={health.agent_ready} />
      </div>
    </div>
  );
}