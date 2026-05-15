import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

function ThinkingDots() {
  return (
    <div style={{ display: 'flex', gap: 5, alignItems: 'center', padding: '8px 0' }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{
          width: 7, height: 7, borderRadius: '50%',
          background: 'var(--violet)',
          animation: `bounce 1.2s infinite ${i * 0.2}s`,
          display: 'inline-block',
        }} />
      ))}
    </div>
  );
}

function Avatar({ role }) {
  const isUser = role === 'user';
  return (
    <div style={{
      width: 34, height: 34, flexShrink: 0, borderRadius: 8,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      border: `1px solid ${isUser ? 'var(--blue)' : 'var(--violet)'}`,
      fontSize: 9, fontWeight: 600, letterSpacing: '0.08em',
      color: isUser ? 'var(--blue)' : 'var(--violet)',
      background: isUser ? 'var(--blue-dim)' : 'var(--violet-dim)',
      fontFamily: 'var(--display)',
    }}>
      {isUser ? 'YOU' : 'RAG'}
    </div>
  );
}

const mdComponents = {
  code({ node, inline, className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || '');
    return !inline && match ? (
      <SyntaxHighlighter
        style={vscDarkPlus}
        language={match[1]}
        PreTag="div"
        customStyle={{ margin: 0, fontSize: 12, borderRadius: 6, background: 'var(--surface2)' }}
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
  const isUser = msg.role === 'user';
  const isError = msg.role === 'error';
  const isThinking = msg.role === 'thinking';

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '34px 1fr',
      gap: 12,
      padding: '14px 20px',
      borderBottom: '1px solid var(--border)',
      animation: 'fadeUp 0.2s ease',
    }}>
      <Avatar role={isUser ? 'user' : 'agent'} />

      <div style={{ minWidth: 0 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          marginBottom: 6, fontSize: 10, color: 'var(--text-dim)', letterSpacing: '0.06em',
        }}>
          <span style={{
            padding: '1px 7px', fontSize: 9, borderRadius: 4,
            border: `1px solid ${isUser ? 'var(--blue)' : isError ? 'var(--error)' : 'var(--violet)'}`,
            color: isUser ? 'var(--blue)' : isError ? 'var(--error)' : 'var(--violet)',
            letterSpacing: '0.08em', fontWeight: 500,
          }}>
            {isUser ? 'QUERY' : isError ? 'ERROR' : 'RESPONSE'}
          </span>
          {msg.ts && <span style={{ color: 'var(--text-dim)' }}>{msg.ts}</span>}
          {msg.attachments?.length > 0 && (
            <span style={{ color: 'var(--violet)', fontSize: 9 }}>
              📎 {msg.attachments.join(', ')}
            </span>
          )}
        </div>

        {isThinking ? (
          <ThinkingDots />
        ) : (
          <div style={{
            background: isUser ? 'var(--blue-dim)' : isError ? 'rgba(239,68,68,0.07)' : 'transparent',
            borderLeft: isUser ? '2px solid var(--blue)' : isError ? '2px solid var(--error)' : 'none',
            padding: isUser || isError ? '10px 14px' : '0',
            borderRadius: isUser || isError ? '0 6px 6px 0' : 0,
          }}>
            {isUser || isError ? (
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 13,
                color: isError ? 'var(--error)' : 'var(--text)',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>
                {msg.content}
                {msg.streaming && (
                  <span style={{
                    display: 'inline-block', width: 8, height: 13,
                    background: 'var(--violet)', marginLeft: 2,
                    verticalAlign: 'middle', animation: 'blink 0.8s infinite',
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
                    display: 'inline-block', width: 8, height: 13,
                    background: 'var(--violet)', marginLeft: 2,
                    verticalAlign: 'middle', animation: 'blink 0.8s infinite',
                  }} />
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}