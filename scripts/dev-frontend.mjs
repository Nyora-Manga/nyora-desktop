import { watch } from 'node:fs';
import { resolve } from 'node:path';
import { buildFrontend, desktopRoot, webRoot } from './build-frontend.mjs';
import { createFrontendServer } from './dev-server.mjs';

const out = await buildFrontend();
const server = await createFrontendServer(out);
console.log('Nyora desktop frontend: http://127.0.0.1:1420 (generated dist only)');
let pending = false;
let running = false;
let timer;
async function rebuild() {
  if (running) { pending = true; return; }
  running = true;
  do {
    pending = false;
    try { await buildFrontend(); console.log('Frontend rebuilt; reload the window to apply.'); }
    catch (error) { console.error(error); }
  } while (pending);
  running = false;
}
const changed = () => { clearTimeout(timer); timer = setTimeout(rebuild, 250); };
const watchers = [watch(resolve(webRoot, 'web'), { recursive: true }, changed), watch(resolve(desktopRoot, 'frontend'), { recursive: true }, changed)];
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  clearTimeout(timer);
  for (const watcher of watchers) watcher.close();
  server.close(() => process.exit(0));
});
