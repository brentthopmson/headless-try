const fs = require('fs');
const content = fs.readFileSync('src/app/emails/cookie/cookie-api-login/route.js', 'utf8');
const lines = content.split('\n');

const lineNumbers = [3245, 3280, 3445, 3495, 6125, 6375, 6425, 6630, 6650, 6685, 6734, 6752, 6781, 7600];

for (const target of lineNumbers) {
    console.log(`\n=== Around line ${target} ===`);
    const start = Math.max(0, target - 5);
    const end = Math.min(lines.length - 1, target + 15);
    for (let i = start; i <= end; i++) {
        console.log(`${i+1}: ${lines[i]}`);
    }
}
