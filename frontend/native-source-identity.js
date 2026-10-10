// Matches main sourceKey syntax. Native catalogue identity is case-sensitive.
export function sourceId(raw) {
  if (raw && typeof raw === 'object') raw = raw.name ?? raw.id;
  return typeof raw === 'string' && /^data:[A-Za-z0-9_.-]{1,200}$/.test(raw) ? raw : '';
}
export function requireSourceId(raw) {
  const id = sourceId(raw);
  if (!id) throw new Error('A canonical native catalogue source identity is required.');
  return id;
}
