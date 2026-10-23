const fs = require('fs');
const vm = require('vm');

const code = fs.readFileSync('src/app/emails/cookie/cookie-api-login/route.js', 'utf8');

try {
    // If vm.SourceTextModule is available (Node 20 with --experimental-vm-modules)
    if (vm.SourceTextModule) {
        new vm.SourceTextModule(code);
        console.log('ESM SourceTextModule check passed!');
    } else {
        // Fallback: replace imports and exports and compile with vm.Script
        const stripped = code
            .replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];?/g, '/* import */')
            .replace(/export\s+default\s+/g, '/* export default */')
            .replace(/export\s+const\s+/g, 'const ')
            .replace(/export\s+async\s+function\s+/g, 'async function ')
            .replace(/export\s+function\s+/g, 'function ');
        new vm.Script(stripped);
        console.log('vm.Script check passed!');
    }
} catch (e) {
    console.error('Syntax check failed:', e);
    process.exit(1);
}
