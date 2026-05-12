const BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export async function checkHealth() {
  const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(4000) });
  return r.json();
}

export async function resetMemory() {
  const r = await fetch(`${BASE}/chat/memory`, { method: 'DELETE' });
  return r.json();
}

export async function chatFull(query) {
  const r = await fetch(`${BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({ detail: r.statusText }));
    throw new Error(e.detail || 'Chat request failed');
  }
  return r.json(); // { query, response }
}

export function chatStream(query, onToken, onDone, onError) {
  const url = `${BASE}/chat/stream?query=${encodeURIComponent(query)}`;
  let cancelled = false;

  fetch(url)
    .then(async (res) => {
      if (!res.ok) {
        const e = await res.json().catch(() => ({ detail: res.statusText }));
        onError(e.detail || 'Stream failed');
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        if (cancelled) break;
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const token = line.slice(6);
          if (token === '[DONE]') { onDone(); return; }
          if (token.startsWith('[ERROR]')) { onError(token.slice(8)); return; }
          onToken(token.replace(/\\n/g, '\n'));
        }
      }
      onDone();
    })
    .catch((e) => {
      if (!cancelled) onError(e.message);
    });

  return () => { cancelled = true; };
}

export async function uploadDocuments(files, chunkSize = 512, chunkOverlap = 64) {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  form.append('chunk_size', chunkSize);
  form.append('chunk_overlap', chunkOverlap);

  const r = await fetch(`${BASE}/ingest/documents/upload`, {
    method: 'POST',
    body: form,
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({ detail: r.statusText }));
    throw new Error(e.detail || 'Upload failed');
  }
  return r.json(); // { message, count, detail }
}

export async function uploadCSV(file, tableName = '') {
  const form = new FormData();
  form.append('file', file);
  if (tableName) form.append('table_name', tableName);

  const r = await fetch(`${BASE}/ingest/csv`, { method: 'POST', body: form });
  if (!r.ok) {
    const e = await r.json().catch(() => ({ detail: r.statusText }));
    throw new Error(e.detail || 'CSV upload failed');
  }
  return r.json();
}