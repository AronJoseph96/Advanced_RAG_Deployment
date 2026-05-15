import { useState, useRef } from 'react';
import { uploadDocuments, uploadCSV } from '../api';

const ACCEPTED_DOCS = '.pdf,.docx,.md,.txt';
const ACCEPTED_CSV = '.csv';

function FileChip({ name, onRemove }) {
  const ext = name.split('.').pop().toUpperCase();
  const extColors = {
    PDF: '#ef4444', DOCX: '#3b82f6', MD: '#a3e635', TXT: '#94a3b8', CSV: '#22c55e',
  };
  const color = extColors[ext] || '#9147ff';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      background: 'var(--surface3)', border: '1px solid var(--border2)',
      padding: '3px 8px', borderRadius: 6, fontSize: 11,
    }}>
      <span style={{ color, fontSize: 9, fontWeight: 500, letterSpacing: '0.06em' }}>{ext}</span>
      <span style={{
        color: 'var(--text)', maxWidth: 120, overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{name}</span>
      <button onClick={onRemove} style={{
        background: 'none', border: 'none', color: 'var(--text-dim)',
        cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: '0 1px',
        display: 'flex', alignItems: 'center',
      }}>×</button>
    </div>
  );
}

function UploadZone({ accepted, multiple, label, tag, tagColor, onUpload }) {
  const [files, setFiles] = useState([]);
  const [status, setStatus] = useState(null);
  const [message, setMessage] = useState('');
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef();

  const addFiles = (incoming) => {
    const arr = Array.from(incoming);
    setFiles(prev => multiple ? [...prev, ...arr] : arr);
    setStatus(null); setMessage('');
  };

  const removeFile = (i) => setFiles(prev => prev.filter((_, idx) => idx !== i));

  const submit = async () => {
    if (!files.length) return;
    setStatus('uploading');
    try {
      const res = await onUpload(files);
      setStatus('done');
      setMessage(res.message + (res.count ? ` · ${res.count} nodes indexed` : ''));
      setFiles([]);
    } catch (e) {
      setStatus('error');
      setMessage(e.message);
    }
  };

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{
          fontSize: 9, letterSpacing: '0.1em', padding: '2px 7px',
          border: `1px solid ${tagColor}`, color: tagColor,
          borderRadius: 4, fontWeight: 500,
        }}>{tag}</span>
        <span style={{ fontSize: 12, color: 'var(--text)', fontFamily: 'var(--display)', fontWeight: 500 }}>{label}</span>
      </div>

      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
        onClick={() => inputRef.current.click()}
        style={{
          border: `1px dashed ${dragging ? tagColor : 'var(--border2)'}`,
          background: dragging ? `${tagColor}11` : 'var(--surface)',
          padding: '14px 10px', textAlign: 'center', cursor: 'pointer',
          borderRadius: 8, transition: 'all 0.15s',
          color: 'var(--text-dim)', fontSize: 11,
        }}
      >
        <div style={{ fontSize: 20, color: dragging ? tagColor : 'var(--border2)', marginBottom: 4 }}>⊕</div>
        <div style={{ letterSpacing: '0.04em' }}>Drop or click to browse</div>
        <div style={{ fontSize: 10, marginTop: 3, color: 'var(--text-dim)' }}>{accepted}</div>
        <input ref={inputRef} type="file" accept={accepted} multiple={multiple}
          style={{ display: 'none' }} onChange={e => addFiles(e.target.files)} />
      </div>

      {files.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
          {files.map((f, i) => <FileChip key={i} name={f.name} onRemove={() => removeFile(i)} />)}
        </div>
      )}

      {message && (
        <div style={{
          marginTop: 8, fontSize: 11, padding: '6px 10px', borderRadius: 6,
          borderLeft: `2px solid ${status === 'error' ? 'var(--error)' : 'var(--success)'}`,
          background: status === 'error' ? 'rgba(239,68,68,0.08)' : 'rgba(29,185,84,0.08)',
          color: status === 'error' ? 'var(--error)' : 'var(--success)',
        }}>
          {message}
        </div>
      )}

      {files.length > 0 && status !== 'uploading' && (
        <button onClick={submit} style={{
          marginTop: 10, width: '100%',
          background: tagColor, border: 'none',
          color: '#fff', fontFamily: 'var(--mono)', fontSize: 11,
          fontWeight: 500, letterSpacing: '0.06em',
          padding: '8px', cursor: 'pointer',
          borderRadius: 6, transition: 'opacity 0.15s',
        }}
          onMouseEnter={e => e.target.style.opacity = '0.85'}
          onMouseLeave={e => e.target.style.opacity = '1'}
        >
          UPLOAD {files.length > 1 ? `(${files.length} files)` : ''}
        </button>
      )}

      {status === 'uploading' && (
        <div style={{ marginTop: 10, textAlign: 'center', color: tagColor, fontSize: 11, letterSpacing: '0.08em' }}>
          <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>◌</span>
          {' '}PROCESSING…
        </div>
      )}
    </div>
  );
}

export default function Sidebar({ agentReady }) {
  return (
    <aside style={{
      width: 256, flexShrink: 0,
      background: 'var(--surface)',
      borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '13px 16px',
        borderBottom: '1px solid var(--border)',
        fontFamily: 'var(--display)',
        fontSize: 11, letterSpacing: '0.12em',
        color: 'var(--text-dim)', fontWeight: 700,
      }}>
        KNOWLEDGE BASE
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
        <UploadZone
          label="Documents"
          tag="VEC"
          tagColor="var(--violet)"
          accepted={ACCEPTED_DOCS}
          multiple={true}
          onUpload={(files) => uploadDocuments(files)}
        />

        <div style={{ height: 1, background: 'var(--border)', margin: '4px 0 18px' }} />

        <UploadZone
          label="Structured CSV"
          tag="SQL"
          tagColor="var(--teal)"
          accepted={ACCEPTED_CSV}
          multiple={false}
          onUpload={(files) => uploadCSV(files[0])}
        />

        {/* Legend */}
        <div style={{
          marginTop: 6, padding: '10px 12px',
          background: 'var(--surface2)', border: '1px solid var(--border)',
          fontSize: 10, color: 'var(--text-dim)', lineHeight: 2,
          borderRadius: 8,
        }}>
          <div><span style={{ color: 'var(--violet)' }}>VEC</span> → Pinecone hybrid RAG</div>
          <div><span style={{ color: 'var(--teal)' }}>SQL</span> → SQLite · NL→SQL</div>
        </div>

        {!agentReady && (
          <div style={{
            marginTop: 12, padding: '8px 12px',
            background: 'var(--warn-dim)', border: '1px solid var(--warn)',
            color: 'var(--warn)', fontSize: 10, letterSpacing: '0.04em',
            borderRadius: 6,
          }}>
            ⚠ Agent not ready — start the FastAPI server on :8000
          </div>
        )}
      </div>
    </aside>
  );
}