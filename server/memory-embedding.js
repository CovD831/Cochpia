// R-007c embedding gateway: bridges the Memory Module's hybrid retrieval to
// an Ollama-served embedding model (bge-m3 on openpilot-air during
// development). The gateway never throws - any failure yields null so the
// retrieval falls back to lexical BM25 exactly as before.

export function createOllamaEmbeddingGateway({
  url = 'http://127.0.0.1:11434/api/embeddings',
  model = 'bge-m3',
  timeoutMs = 10_000
} = {}) {
  return async function embed(text, options = {}) {
    const input = String(text || '');
    if (!input.trim()) return null;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: input.slice(0, 4000) }),
        signal: options.signal ?? AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) return null;
      const parsed = await response.json().catch(() => null);
      const vector = parsed?.embedding;
      return Array.isArray(vector) && vector.length > 0 && vector.every(Number.isFinite) ? vector : null;
    } catch {
      return null;
    }
  };
}
