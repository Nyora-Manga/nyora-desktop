'use strict';

// Only the currently bundled reader's pinned models and named provider routes.
// ONNX JavaScript/WASM remains self-hosted; old Hugging Face cache keys do not
// authorize any network access. A model revision requires a policy revision.
const READER_CONNECTIONS = Object.freeze([
  'https://raw.githubusercontent.com/Nyora-Manga/manga-colorization-v2-onnx/044b94a18a5a2e92cb320d8d69cc7583941d3678/',
  'https://raw.githubusercontent.com/Nyora-Manga/nyora-translate-models/cf33c2959f02f5a48ad2bc98bd80b0b50b8632ec/',
  'https://translate.googleapis.com/translate_a/single',
  'https://api.openai.com/v1/chat/completions',
  'https://api.anthropic.com/v1/messages',
  'https://*.fandom.com/api.php',
]);
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  `connect-src 'self' https://api.nyora.xyz https://graphql.anilist.co https://api.mangabaka.dev https://api.mangabaka.org ${READER_CONNECTIONS.join(' ')}`,
  "worker-src 'self' blob:", "object-src 'none'", "base-uri 'self'", "frame-src 'none'", "frame-ancestors 'none'", "form-action 'none'",
].join('; ');

function normalizeAiEndpoint(value, { legacy = false, provider } = {}) {
  if (typeof value !== 'string') throw new Error('AI endpoint must be text');
  if (value === '') return '';
  const normalized = value.replace(/\/$/, '');
  if (normalized === 'https://api.openai.com/v1' && (!provider || provider === 'openai')) return normalized;
  // The bundled Anthropic reader appends /v1/messages itself. Accept its default
  // origin and the conventional API base input, then persist the working form.
  if (['https://api.anthropic.com', 'https://api.anthropic.com/v1'].includes(normalized) && (!provider || provider === 'anthropic')) return 'https://api.anthropic.com';
  if (legacy) return '';
  throw new Error('Custom AI endpoints are not yet supported on desktop. Leave the endpoint empty to use the selected provider.');
}
module.exports = { CONTENT_SECURITY_POLICY, normalizeAiEndpoint };
