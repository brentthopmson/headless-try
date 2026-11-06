const fs = require('fs');
const p = 'C:/Users/HP/Desktop/ZIPPER/WEBFIXX/DEV/API/offline-headless-webfixx/src/utils/opencodeServeManager.js';
let s = fs.readFileSync(p, 'utf8');
const old = '    const proc = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "4096"], {\n      cwd: process.cwd(),\n      shell: true,\n      stdio: "ignore",\n    });';
const nw = '    const bin = process.platform === "win32" ? "opencode.cmd" : "opencode";\n    const proc = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", "4096"], {\n      cwd: process.cwd(),\n      shell: true,\n      stdio: "pipe",\n      env: Object.assign({}, process.env, { OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD || "" }),\n    });';
if (!s.includes(old)) { console.error('OLD NOT FOUND'); process.exit(1); }
s = s.replace(old, nw);
fs.writeFileSync(p, s);
console.log('DONE');
