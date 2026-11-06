const https = require('https');
const url = process.env.SCRIPT_EXEC_URL || 'https://script.google.com/macros/s/AKfycbwlTdSRNV2JJUfJgNowIZjrDrxlrhJvbRxUUOA4f6LRQ3b84hGZS_FE4ylLKrOy-z5Ew/exec';
const secret = process.env.OPENCODE_SYNC_SECRET || 'opencode_sync_secret_2025';
const payload = {action:'syncOpencodePasswordToAi', secret, password:'WUyaw1mAlqNc5b2d', provider:'opencode'};
const data = JSON.stringify(payload);
const req = https.request(url, {method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}}, res=>{
  let b=''; res.on('data',d=>b+=d); res.on('end',()=>{console.log(res.statusCode); console.log(b);});
});
req.on('error',e=>console.error(e.message));
req.write(data);
req.end();
