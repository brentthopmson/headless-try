const fs=require('fs');
const pwd=(fs.readFileSync('.env','utf8').match(/^\s*OPENCODE_SERVER_PASSWORD=(.*)$/m)||[])[1]?.trim()||'';
const auth='Basic '+Buffer.from('opencode:'+pwd).toString('base64');
const base='http://127.0.0.1:4096'; const h={Authorization:auth,'Content-Type':'application/json',Accept:'application/json'};
(async()=>{
  const cs=await fetch(base+'/api/session',{method:'POST',headers:h,body:JSON.stringify({}),signal:AbortSignal.timeout(15000)});
  const cj=await cs.json(); const sid=cj.data?.id||cj.id;
  const model={providerID:'opencode-go',modelID:'hy4'};
  const body={parts:[{type:'text',text:'Reply with exactly this text and nothing else: OPENCODE_ENGINE_OK'}], model};
  const r=await fetch(base+'/session/'+sid+'/message',{method:'POST',headers:h,body:JSON.stringify(body),signal:AbortSignal.timeout(150000)});
  const j=await r.json();
  console.log('info.error:', JSON.stringify(j.info?.error||null));
  console.log('parts:', JSON.stringify((j.parts||[]).map(p=>({type:p.type,text:(p.text||'').slice(0,120)}))));
  // also try to find text in other shapes
  const all=JSON.stringify(j);
  const m=all.match(/OPENCODE_ENGINE_OK/);
  console.log('contains_OK:', !!m);
  if(!m) console.log('full_keys:', Object.keys(j), 'info_keys:', Object.keys(j.info||{}));
})();
