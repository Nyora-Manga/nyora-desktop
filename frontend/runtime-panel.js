export function mountRuntimePanel(adapter, host) {
  const node = (tag, text) => {
    const element = document.createElement(tag);
    if (tag === 'button') element.className = 'btn btn-sm';
    if (tag === 'input') element.className = 'input';
    if (text) element.textContent = text;
    return element;
  };
  const panel = node('details');
  panel.id = 'desktop-runtime';
  panel.append(node('summary', 'Website sessions and diagnostics'));
  const body = node('div');
  body.className = 'desktop-runtime-body';
  body.append(node('p', 'Website sessions are saved automatically on this device. Reset a source session only if its website keeps failing after verification.'));
  const status = node('p', 'Checking native runtime…');
  status.setAttribute('role', 'status');
  const identity = node('pre');
  const diagnostics = node('details'); diagnostics.className = 'desktop-runtime-diagnostics';
  diagnostics.append(node('summary', 'Runtime details'), identity);
  body.append(status, diagnostics);
  const refresh = node('button', 'Refresh runtime status');
  refresh.type = 'button';
  body.append(refresh);
  const form = node('form');
  form.className = 'desktop-runtime-form';
  const sourceLabel = node('label', 'Source');
  const source = node('select'); source.className='input';source.required=true;source.setAttribute('aria-label','Source');
  for(const entry of globalThis.NYORA_SERVICES.sources.snapshot().catalog){const option=node('option',entry.name);option.value=entry.id;source.append(option);}
  sourceLabel.append(source);
  const open = node('button', 'Open website');
  open.type = 'submit';
  open.disabled = true;
  const reset = node('button', 'Reset this source session');
  reset.type = 'button';
  reset.disabled = true;
  const actions = node('div'); actions.className = 'desktop-runtime-actions'; actions.append(open, reset);
  form.append(sourceLabel, actions);
  body.append(form, node('p', 'Complete any check, then close the website window. Your session is saved automatically and Nyora checks source access. Close the window before resetting this source.'));
  panel.append(body);
  host?.append(panel);
  let available = false;
  const run = async (action) => {
    open.disabled = reset.disabled = refresh.disabled = true;
    try { await action(); }
    catch (error) { status.textContent = String(error?.message || error); }
    finally { refresh.disabled = false; open.disabled = reset.disabled = !available; }
  };
  const refreshStatus = () => run(async () => {
    const result = await adapter.runtimeStatus();
    identity.textContent = JSON.stringify(result, null, 2);
    available = result.verificationAvailable === true;
    status.textContent = result.runtime === 'electron'
      ? `Chromium ${result.browserVersion || '(version unavailable)'} · Electron ${result.electronVersion || '(version unavailable)'} · ${result.profileName} profile`
      : 'Unexpected runtime identity; Electron verification has not passed.';
  });
  refresh.addEventListener('click', refreshStatus);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!available || !form.reportValidity()) return;
    run(async () => {
      await adapter.openVerification(source.value);
      status.textContent = 'Website opened. Complete any check, then close the window.';
      window.dispatchEvent(new CustomEvent('nyora:native-request-failed'));
    });
  });
  reset.addEventListener('click', () => {
    if (!available || !source.reportValidity()) return;
    run(async () => {
      const result = await adapter.resetSourceSession(source.value.trim());
      status.textContent = result.reset === true ? 'Source session reset.' : 'Session reset was not confirmed.';
    });
  });
  refreshStatus();
  return panel;
}
