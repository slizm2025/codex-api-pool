// TDD: x-codex-api-pool-upstream response header on /v1/messages paths.
//
// CORE_FEATURES §2/§11 + Dashboard contract: the pool sets an
// x-codex-api-pool-upstream response header so the client and Dashboard can see
// which upstream served a request. The /v1/responses path sets it. The /v1/messages
// path (native forwarding AND Messages→Chat adapter) must set it too for parity.

import http from 'node:http';
import { createPoolServer } from '../src/server.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const statsRoot = await mkdtemp(path.join(tmpdir(), 'codex-msg-hdr-'));
let passed = 0, failed = 0;
function listen(s){return new Promise(r=>s.listen(0,'127.0.0.1',()=>{const a=s.address();r({port:a.port,url:`http://127.0.0.1:${a.port}`})}));}
function close(s){return new Promise(r=>{setImmediate(()=>{s.closeIdleConnections?.();s.closeAllConnections?.()});s.close(()=>r())});}
async function test(name, fn){try{await fn();passed++;console.log(`✓ ${name}`);}catch(e){failed++;console.log(`✗ ${name}\n  ${e.message}`);}}

process.env.MH_POOL='t'; process.env.MH_KEY='k';
const auth={authorization:`Bearer ${process.env.MH_POOL}`,'content-type':'application/json'};

console.log('🧪 /v1/messages x-codex-api-pool-upstream header tests\n');

await test('Native Messages forwarding sets x-codex-api-pool-upstream', async () => {
  const up=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'m',type:'message',role:'assistant',content:[{type:'text',text:'ok'}],model:'claude-opus-4-8',stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}}))});
  const ui=await listen(up);
  const pool=createPoolServer({server:{host:'127.0.0.1',port:0,public_prefix:'/v1',auth_token_env:'MH_POOL'},health:{enabled:false},retry:{max_attempts:1},upstreams:[{name:'ant',base_url:`${ui.url}`,api:'anthropic',weight:1,keys:[{env:'MH_KEY'}]}]},{statsPath:path.join(statsRoot,'n.json')});
  const pi=await listen(pool);
  try{
    const r=await fetch(`${pi.url}/v1/messages`,{method:'POST',headers:auth,body:JSON.stringify({model:'claude-opus-4-8',messages:[{role:'user',content:'hi'}],max_tokens:10})});
    if(r.status!==200) throw new Error(`status ${r.status}: ${await r.text()}`);
    const h=r.headers.get('x-codex-api-pool-upstream');
    if(h!=='ant') throw new Error(`expected x-codex-api-pool-upstream=ant, got ${h}`);
  }finally{await close(pool);await close(up);}
});

await test('Messages→Chat adapter sets x-codex-api-pool-upstream', async () => {
  const up=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'c',object:'chat.completion',model:'gpt-4',choices:[{message:{role:'assistant',content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}))});
  const ui=await listen(up);
  const pool=createPoolServer({server:{host:'127.0.0.1',port:0,public_prefix:'/v1',auth_token_env:'MH_POOL'},health:{enabled:false},retry:{max_attempts:1},compatibility:{adapter_mode:{strip_messages_only_features:true,adapters:{chat_completions:true}}},upstreams:[{name:'oai',base_url:`${ui.url}`,api:'openai',weight:1,keys:[{env:'MH_KEY'}]}]},{statsPath:path.join(statsRoot,'a.json')});
  const pi=await listen(pool);
  try{
    const r=await fetch(`${pi.url}/v1/messages`,{method:'POST',headers:auth,body:JSON.stringify({model:'claude-opus-4-8',messages:[{role:'user',content:'hi'}],max_tokens:10})});
    if(r.status!==200) throw new Error(`status ${r.status}: ${await r.text()}`);
    const h=r.headers.get('x-codex-api-pool-upstream');
    if(h!=='oai') throw new Error(`expected x-codex-api-pool-upstream=oai, got ${h}`);
  }finally{await close(pool);await close(up);}
});

console.log(`\n${'='.repeat(50)}\nResults: ${passed} passed, ${failed} failed\n${'='.repeat(50)}`);
process.exit(failed>0?1:0);
