'use strict';
// npm postinstall: npm reports success even when Electron's download did not unpack (Electron
// 33's installer leaves only dist\locales under Node 26), and the app then fails to start.
const fs = require('fs');
const path = require('path');

const exe = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
if (process.platform === 'win32' && !fs.existsSync(exe)) {
  console.error(`
Electron did not unpack (no ${path.relative(process.cwd(), exe)}), so the app cannot start.
This happens with Node.js ${process.version}; use Node.js 20, then reinstall:
    fnm install 20; fnm use 20      (or install Node.js 20 another way)
    Remove-Item -Recurse -Force node_modules\\electron
    npm ci
`);
  process.exit(1);
}
