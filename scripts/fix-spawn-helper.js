// node-pty 的 spawn-helper 在某些安裝方式下會失去執行權限，導致 "posix_spawnp failed"
const fs = require('fs');
const path = require('path');

const base = path.join(__dirname, '..', 'node_modules', 'node-pty');
for (const dir of ['prebuilds/darwin-arm64', 'prebuilds/darwin-x64', 'build/Release']) {
  const p = path.join(base, dir, 'spawn-helper');
  try {
    if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
  } catch (_) {}
}
