import { useState, useRef } from 'react';
import { uploadDocuments, uploadCSV } from '../api';

const ACCEPTED_DOCS = '.pdf,.docx,.md,.txt';
const ACCEPTED_CSV  = '.csv';

function FileChip({ name, onRemove }) {
  const ext = name.split('.').pop().toUpperCase();
  return (
    <div style={{
      display:'flex', alignItems:'center', gap:6,
      background:'var(--surface2)', border:'1px solid var(--border2)',
      padding:'3px 8px', fontSize:11,
    }}>
      <span style={{ color:'var(--accent)', fontSize:10, letterSpacing:'0.06em' }}>{ext}</span>
      <span style={{ color:'var(--text)', maxWidth:120, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{name}</span>
      <button onClick={onRemove} style={{
        background:'none', border:'none', color:'var(--text-dim)',
        cursor:'pointer', fontSize:14, lineHeight:1, padding:'0 2px',
      }}>×</button>
    </div>
  );
}

function UploadSection({ title, tag, accepted, multiple, onUpload }) {
  const [files, setFiles]       = useState([]);
  const [status, setStatus]     = useState(null); // null | 'uploading' | 'done' | 'error'
  const [message, setMessage]   = useState('');
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef();

  const addFiles = (incoming) => {
    const arr = Array.from(incoming);
    setFiles(prev => multiple ? [...prev, ...arr] : arr);
    setStatus(null);
  };

  const removeFile = (i) => setFiles(prev => prev.filter((_, idx) => idx !== i));

  const handleDrop = (e) => {
    e.preventDefault(); setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const submit = async () => {
    if (!files.length) return;
    setStatus('uploading');
    setMessage('');
    try {
      const res = await onUpload(files);
      setStatus('done');
      setMessage(res.message + (res.count ? ` (${res.count} nodes)` : ''));
      setFiles([]);
    } catch (e) {
      setStatus('error');
      setMessage(e.message);
    }
  };

  const borderColor = dragging ? 'var(--accent)' : 'var(--border2)';

  return (
    <div style={{ marginBottom:24 }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
        <span style={{ fontSize:9, letterSpacing:'0.1em', color:'var(--accent)', border:'1px solid var(--accent)', padding:'1px 6px' }}>{tag}</span>
        <span style={{ fontSize:12, color:'var(--text)', fontFamily:'var(--display)', letterSpacing:'0.02em' }}>{title}</span>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current.click()}
        style={{
          border: `1px dashed ${borderColor}`,
          background: dragging ? 'var(--accent-dim)' : 'var(--surface)',
          padding: '16px 12px',
          textAlign: 'center',
          cursor: 'pointer',
          transition: 'all 0.15s',
          color: 'var(--text-dim)',
          fontSize: 11,
          letterSpacing: '0.05em',
        }}
      >
        <div style={{ marginBottom:4, fontSize:18, color: dragging ? 'var(--accent)' : 'var(--border2)' }}>⊕</div>
        Drop files or click to browse
        <div style={{ marginTop:4, color:'var(--text-dim)', fontSize:10 }}>{accepted}</div>
        <input
          ref={inputRef}
          type="file"
          accept={accepted}
          multiple={multiple}
          style={{ display:'none' }}
          onChange={e => addFiles(e.target.files)}
        />
      </div>

      {/* File chips */}
      {files.length > 0 && (
        <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginTop:8 }}>
          {files.map((f, i) => (
            <FileChip key={i} name={f.name} onRemove={() => removeFile(i)} />
          ))}
        </div>
      )}

      {/* Status */}
      {message && (
        <div style={{
          marginTop:8, fontSize:11, padding:'6px 10px',
          borderLeft: `2px solid ${status === 'error' ? 'var(--warn)' : 'var(--success)'}`,
          background: status === 'error' ? 'var(--warn-dim)' : 'rgba(34,197,94,0.08)',
          color: status === 'error' ? 'var(--warn)' : 'var(--success)',
        }}>
          {message}
        </div>
      )}

      {/* Upload button */}
      {files.length > 0 && status !== 'uploading' && (
        <button onClick={submit} style={{
          marginTop:10, width:'100%',
          background: 'var(--accent)', border:'none',
          color:'#000', fontFamily:'var(--mono)', fontSize:11,
          fontWeight:600, letterSpacing:'0.08em',
          padding:'8px', cursor:'pointer',
          transition:'background 0.15s',
        }}
        onMouseEnter={e => e.target.style.background='#00ffcc'}
        onMouseLeave={e => e.target.style.background='var(--accent)'}
        >
          UPLOAD {files.length > 1 ? `(${files.length})` : ''}
        </button>
      )}

      {status === 'uploading' && (
        <div style={{ marginTop:10, textAlign:'center', color:'var(--accent)', fontSize:11, letterSpacing:'0.08em' }}>
          <span style={{ animation:'spin 1s linear infinite', display:'inline-block' }}>◌</span>
          {' '}PROCESSING…
        </div>
      )}
    </div>
  );
}

export default function Sidebar({ agentReady }) {
  return (
    <aside style={{
      width: 260,
      flexShrink: 0,
      background: 'var(--surface)',
      borderRight: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '14px 16px',
        borderBottom: '1px solid var(--border)',
        fontFamily: 'var(--display)',
        fontSize: 12,
        letterSpacing: '0.12em',
        color: 'var(--text-dim)',
      }}>
        KNOWLEDGE BASE
      </div>

      <div style={{ flex:1, overflowY:'auto', padding:'16px' }}>
        <UploadSection
          title="Documents"
          tag="VEC"
          accepted={ACCEPTED_DOCS}
          multiple={true}
          onUpload={(files) => uploadDocuments(files)}
        />

        <div style={{ height:1, background:'var(--border)', margin:'4px 0 20px' }} />

        <UploadSection
          title="Structured CSV"
          tag="SQL"
          accepted={ACCEPTED_CSV}
          multiple={false}
          onUpload={(files) => uploadCSV(files[0])}
        />

        {/* Legend */}
        <div style={{
          marginTop:8, padding:'10px 12px',
          background:'var(--surface2)', border:'1px solid var(--border)',
          fontSize:10, color:'var(--text-dim)', lineHeight:2,
        }}>
          <div><span style={{color:'var(--accent)'}}>VEC</span> → Pinecone (hybrid RAG)</div>
          <div><span style={{color:'var(--blue)'}}>SQL</span> → SQLite (NL→SQL)</div>
        </div>

        {!agentReady && (
          <div style={{
            marginTop:12, padding:'8px 12px',
            background:'var(--warn-dim)', border:'1px solid var(--warn)',
            color:'var(--warn)', fontSize:10, letterSpacing:'0.04em',
          }}>
            ⚠ Agent not ready. Start the FastAPI server.
          </div>
        )}
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </aside>
  );
}