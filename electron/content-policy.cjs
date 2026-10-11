'use strict';

// The reader may connect anywhere: page CDNs, any translation/LLM endpoint
// (including a local server such as Ollama or LM Studio), wikis and catalogue
// APIs. Responses are opened to this origin by cors.cjs. Scripts stay 'self'.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
  "worker-src 'self' blob:", "object-src 'none'", "base-uri 'self'", "frame-src 'none'", "frame-ancestors 'none'", "form-action 'none'",
].join('; ');

// Any HTTPS endpoint, or plain HTTP on this machine (local LLM servers). The
// reader appends /chat/completions (OpenAI-compatible) or /v1/messages
// (Anthropic) itself, so store the API base.
function normalizeAiEndpoint(value, { legacy = false, provider } = {}) {
  if (typeof value !== 'string') throw new Error('AI endpoint must be text');
  if (value === '') return '';
  let url;
  try { url = new URL(value.trim()); } catch { url = null; }
  const local = url && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!url || !(url.protocol === 'https:' || local) || url.username || url.password || url.hash) {
    if (legacy) return '';
    throw new Error('AI endpoint must be an https:// URL, or http://localhost for a local server.');
  }
  const normalized = url.href.replace(/\/+$/, '');
  // The bundled Anthropic reader appends /v1/messages itself. Accept its default
  // origin and the conventional API base input, then persist the working form.
  const anthropic = ['https://api.anthropic.com', 'https://api.anthropic.com/v1'].includes(normalized);
  // One built-in provider's endpoint under the other provider can never work.
  if ((anthropic && provider === 'openai') || (normalized === 'https://api.openai.com/v1' && provider === 'anthropic')) {
    if (legacy) return '';
    throw new Error("That is the other provider's endpoint. Leave it empty to use the selected provider.");
  }
  return anthropic ? 'https://api.anthropic.com' : normalized;
}
module.exports = { CONTENT_SECURITY_POLICY, normalizeAiEndpoint };
