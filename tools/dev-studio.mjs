import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const index = spawnSync(process.execPath, ['tools/index-cleanclient-assets.mjs', '--if-available'], {
  stdio: 'inherit',
  env: process.env,
});
if (index.status && index.status !== 0) {
  console.warn(`[studio] asset indexing exited with code ${index.status}; Studio will continue with the local-tile browser.`);
}

const children = [
  spawn(npm, ['--workspace', '@wowsergl/bridge', 'run', 'start'], { stdio: 'inherit', env: process.env }),
  spawn(npm, ['--workspace', '@wowsergl/editor', 'run', 'dev'], { stdio: 'inherit', env: process.env }),
];

if (process.env.STUDIO_EXTERNAL_ADAPTER !== '0') {
  children.push(spawn(process.execPath, ['apps/bridge/external-runtime-adapter.mjs'], {
    stdio: 'inherit',
    env: process.env,
  }));
}

console.log('[studio] VanillaGL remains a separate read-only target. Live Game-view sync is provided by the external CDP adapter.');
console.log('[studio] Launch Chrome/Edge with --remote-debugging-port=9222 (or set VANILLAGL_CDP_URL) for live runtime attachment.');

let exiting = false;
const stop = (code = 0) => {
  if (exiting) return;
  exiting = true;
  for (const child of children) if (!child.killed) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 250).unref?.();
};

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (exiting) return;
    if (code && code !== 0) {
      console.error(`[studio] child exited with code ${code}${signal ? ` (${signal})` : ''}`);
      stop(code);
    }
  });
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
