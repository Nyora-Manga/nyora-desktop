export const verificationInstructions = 'Complete any check, then close the window. Nyora will check the source automatically.';

export function formatCookieStatus(cookies) {
  if (cookies?.state === 'saving') return 'Saving your session…';
  if (cookies?.state === 'failed') return 'Your session could not be saved. You may need to verify again after restarting the app.';
  return '';
}

export function verificationAction(entry, recovery) {
  if (entry?.cookies?.state === 'saving') return { label: 'Saving session…', disabled: true };
  if (recovery?.state === 'checking') return { label: 'Checking…', disabled: true };
  if (entry?.phase === 'verification-opened') return { label: entry.manual ? 'Website open' : 'Verification open', disabled: true };
  return { label: entry?.phase === 'verification-required' && !entry.manual ? 'Verify source' : 'Open website', disabled: false };
}

let currentEntries = new Map(), currentRecovery = new Map();
const buttons = new Set();
function applyState(button) {
  const sourceId = button.dataset.sourceId;
  const entry = currentEntries.get(sourceId);
  const state = verificationAction(entry, currentRecovery.get(sourceId));
  button.textContent = state.label;
  button.disabled = state.disabled;
  button.title = entry && !entry.manual ? verificationInstructions : 'Open this source website';
}
// One trusted status poll updates every mounted source control. Catalog rows
// never fan out into native requests or retain disconnected button listeners.
export function updateSourceVerification(entries, recovery = new Map()) {
  currentEntries = new Map(entries.map(entry => [entry.sourceId, entry]));
  currentRecovery = recovery;
  for (const reference of buttons) {
    const button = reference.deref();
    if (!button?.isConnected) { buttons.delete(reference); continue; }
    applyState(button);
  }
}

// Main chooses the catalogue-bound target and decides whether access works.
export function sourceVerificationButton(source) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'btn btn-ghost btn-sm desktop-verify-source';
  button.dataset.sourceId = source.id;
  applyState(button); buttons.add(new WeakRef(button));
  button.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); });
  button.addEventListener('click', async (event) => {
    event.stopPropagation(); button.disabled = true;
    try {
      await globalThis.NYORA_DESKTOP.openVerification(source.id);
      window.dispatchEvent(new CustomEvent('nyora:native-request-failed'));
    } catch (error) {
      button.title = String(error.message || error);
      window.dispatchEvent(new CustomEvent('nyora:verification-error', { detail: button.title }));
    } finally { applyState(button); }
  });
  return button;
}
