import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const index = spawnSync(process.execPath, ['tools/index-cleanclient-assets.mjs', '--if-available'], { stdio: 'inherit', env: process.env });
if (index.status && index.status !== 0) console.warn(`[studio] asset indexing exited with code ${index.status}; Studio will continue with the local-tile browser.`);

const children = [
  spawn(npm, ['--workspace', '@wowsergl/bridge', 'run', 'start'], { stdio: 'inherit', env: process.env }),
  spawn(npm, ['--workspace', '@wowsergl/editor', 'run', 'dev'], { stdio: 'inherit', env: process.env }),
];

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
