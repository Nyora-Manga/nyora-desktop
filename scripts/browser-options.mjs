import {access} from 'node:fs/promises';

// CI installs Playwright Chromium; local macOS can reuse an installed Chrome.
export async function browserOptions() {
  if (process.env.CHROMIUM_PATH) return {executablePath:process.env.CHROMIUM_PATH};
  const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if(process.platform==='darwin' && await access(chrome).then(()=>true,()=>false)) return {executablePath:chrome};
  return {};
}
