import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

function ThinkingDots() {
  return (
    <div style={{ display:'flex', gap:5, alignItems:'center', padding:'10px 0' }}>
      {[0,1,2].map(i => (
        <span key={i} style={{
          width:6, height:6, borderRadius:'50%',
          background:'var(--accent)',
          animation:`bounce 1.2s infinite ${i*0.2}s`,
        }} />
      ))}
      <style>{`
        @keyframes bounce {
          0%,80%,100%{transform:scale(0.5);opacity:0.3}
          40%{transform:scale(1);opacity:1}
        }
      `}</style>
    </div>
  );
}

function Avatar({ role }) {
  const isUser = role === 'user';
  return (
    <div style={{
      width:32, height:32, flexShrink:0,
      display:'flex', alignItems:'center', justifyContent:'center',
      border:`1px solid ${isUser ? 'var(--blue)' : 'var(--accent)'}`,
      fontSize:9, fontWeight:600, letterSpacing:'0.08em',
      color: isUser ? 'var(--blue)' : 'var(--accent)',
      background: isUser ? 'var(--blue-dim)' : 'var(--accent-dim)',
    }}>
      {isUser ? 'USR' : 'RAG'}
    </div>
  );
}

const mdComponents = {
  code({ node, inline, className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || '');
    return !inline && match ? (
      <SyntaxHighlighter
        style={oneDark}
        language={match[1]}
        PreTag="div"
        customStyle={{ margin:0, fontSize:12, borderRadius:0, background:'var(--surface2)' }}
        {...props}
      >
        {String(children).replace(/\n$/, '')}
      </SyntaxHighlighter>
    ) : (
      <code className={className} {...props}>{children}</code>
    );
  },
};

export default function Message({ msg }) {
  const isUser    = msg.role === 'user';
  const isError   = msg.role === 'error';
  const isThinking = msg.role === 'thinking';

  const bgColor = isUser ? 'var(--blue-dim)' : isError ? 'var(--warn-dim)' : 'transparent';
  const borderLeft = isUser
    ? '2px solid var(--blue)'
    : isError
    ? '2px solid var(--warn)'
    : 'none';

  return (
    <div style={{
      display:'grid',
      gridTemplateColumns: '32px 1fr',
      gap:12,
      padding:'14px 20px',
      borderBottom:'1px solid var(--border)',
      animation:'fadeIn 0.2s ease',
    }}>
      <style>{`@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}`}</style>

      <Avatar role={isUser ? 'user' : 'agent'} />

      <div style={{ minWidth:0 }}>
        {/* Meta row */}
        <div style={{
          display:'flex', alignItems:'center', gap:8,
          marginBottom:6, fontSize:10, color:'var(--text-dim)', letterSpacing:'0.06em',
        }}>
          <span style={{
            padding:'1px 6px', fontSize:9,
            border:`1px solid ${isUser ? 'var(--blue)' : isError ? 'var(--warn)' : 'var(--accent)'}`,
            color: isUser ? 'var(--blue)' : isError ? 'var(--warn)' : 'var(--accent)',
            letterSpacing:'0.08em',
          }}>
            {isUser ? 'QUERY' : isError ? 'ERROR' : 'RESPONSE'}
          </span>
          {msg.ts && <span>{msg.ts}</span>}
        </div>

        {/* Content */}
        {isThinking ? (
          <ThinkingDots />
        ) : (
          <div style={{
            background: bgColor,
            borderLeft,
            padding: isUser || isError ? '10px 14px' : '0',
          }}>
            {isUser || isError ? (
              <span style={{
                fontFamily:'var(--mono)',
                fontSize:13,
                color: isError ? 'var(--warn)' : 'var(--text)',
                whiteSpace:'pre-wrap',
                wordBreak:'break-word',
              }}>
                {msg.content}
                {msg.streaming && (
                  <span style={{
                    display:'inline-block', width:8, height:13,
                    background:'var(--accent)', marginLeft:2,
                    verticalAlign:'middle',
                    animation:'blink 0.8s infinite',
                  }} />
                )}
              </span>
            ) : (
              <div className="md-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                  {msg.content}
                </ReactMarkdown>
                {msg.streaming && (
                  <span style={{
                    display:'inline-block', width:8, height:13,
                    background:'var(--accent)', marginLeft:2,
                    verticalAlign:'middle',
                    animation:'blink 0.8s infinite',
                  }} />
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}`}</style>
    </div>
  );
}