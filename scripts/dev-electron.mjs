import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { resolve } from 'node:path';
import electron from 'electron';
import { buildFrontend, desktopRoot, webRoot } from './build-frontend.mjs';

await buildFrontend();
// Development uses the same secure app origin and sandboxed runtime as the
// packaged app. The standalone dev:frontend HTTP server is available separately.
const child = spawn(electron, [desktopRoot], { cwd: desktopRoot, stdio: 'inherit' });
let timer;
let running = false;
let pending = false;
async function rebuild() {
  if (running) { pending = true; return; }
  running = true;
  do {
    pending = false;
    try { await buildFrontend(); console.log('Frontend rebuilt; refresh the window to apply.'); }
    catch (error) { console.error(error); }
  } while (pending);
  running = false;
}
const changed = () => { clearTimeout(timer); timer = setTimeout(rebuild, 250); };
const watchers = [watch(resolve(webRoot, 'web'), { recursive: true }, changed), watch(resolve(desktopRoot, 'frontend'), { recursive: true }, changed)];
const cleanup = () => { clearTimeout(timer); for (const watcher of watchers) watcher.close(); };
child.on('error', (error) => { cleanup(); console.error(error); process.exitCode = 1; });
child.on('exit', (code) => { cleanup(); process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cleanup(); child.kill(signal); });
