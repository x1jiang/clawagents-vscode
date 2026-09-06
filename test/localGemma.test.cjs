const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const cp = require('node:child_process');
const test = require('node:test');
const { buildSync } = require('esbuild');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemma-manager-test-'));
const bundle = path.join(root, 'localGemma.cjs');
buildSync({entryPoints:[path.join(__dirname,'../src/localGemma.ts')],outfile:bundle,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
const mod = require(bundle);
const protocolBundle = path.join(root, 'protocol.cjs');
buildSync({entryPoints:[path.join(__dirname,'../src/protocol.ts')],outfile:protocolBundle,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
const protocol = require(protocolBundle);
const binary = path.join(root,'llama-server');
const model = path.join(root,'model.gguf');
fs.writeFileSync(binary,'fixture'); fs.writeFileSync(model,'fixture');
const manifest = {binary,model,devices:['CUDA0']};
const originalSpawn = cp.spawn;
const originalKill = process.kill;
let calls, children, servers, failGpu, stall;
let pid = 900000;
function fakeSpawn(cmd,args,opts) {
  calls.push({cmd,args,opts});
  const child = new EventEmitter();
  Object.assign(child,{pid:++pid,exitCode:null,signalCode:null,stdout:new PassThrough(),stderr:new PassThrough()});
  children.set(child.pid,child);
  child.kill = (signal='SIGTERM') => {
    child.signalCode = signal;
    child.server?.close();
    setImmediate(()=>{child.emit('exit',null);child.emit('close',null);});
    return true;
  };
  setImmediate(()=>{
    if (args.includes('--root')) {
      if (stall) return;
      child.stdout.write(JSON.stringify({ready:manifest,message:'ready'})+'\n');
      child.exitCode=0;child.emit('exit',0);child.emit('close',0);
    } else {
      const gpu = args[args.indexOf('--n-gpu-layers')+1] !== '0';
      if (failGpu && gpu) {
        child.stderr.write('GPU allocation failed');child.exitCode=1;child.emit('exit',1);child.emit('close',1);return;
      }
      const aliases=args[args.indexOf('--alias')+1].split(',');
      child.server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:aliases[0],aliases}]}));});
      servers.push(child.server);
      child.server.listen(Number(args[args.indexOf('--port')+1]),'127.0.0.1');
    }
  });
  return child;
}
test.beforeEach(()=>{
  calls=[]; children=new Map();servers=[];failGpu=false;stall=false;
  cp.spawn=fakeSpawn;
  process.kill=(p,sig)=>{const child=children.get(Math.abs(p));if(child)return child.kill(sig);return originalKill(p,sig);};
});
test.afterEach(()=>{ for(const s of servers)s.close();cp.spawn=originalSpawn;process.kill=originalKill; });
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));

test('construction and protocol selection perform no installation',()=>{
  const manager=new mod.LocalGemmaManager(root,'installer.py',()=>{});
  assert.equal(calls.length,0); assert.equal(manager.status.phase,'idle');
  assert.equal(protocol.parseWebviewToHost({type:'setup_local_gemma'}).type,'setup_local_gemma');
  assert.equal(protocol.parseWebviewToHost({type:'stop_local_gemma'}).type,'stop_local_gemma');
  manager.dispose();
});

test('GPU fit and CPU fallback arguments bind localhost and preserve tool parsing',()=>{
  const gpu=mod.gemmaServerArgs(manifest,20000);
  assert.equal(gpu[gpu.indexOf('--n-gpu-layers')+1],'auto');
  assert.equal(gpu[gpu.indexOf('--host')+1],'127.0.0.1');assert.ok(gpu.includes('--jinja'));
  const cpu=mod.gemmaServerArgs(manifest,20000,true);
  assert.equal(cpu[cpu.indexOf('--n-gpu-layers')+1],'0');assert.equal(cpu[cpu.indexOf('--device')+1],'none');
});

test('server environment excludes cloud credentials and inherited runtime overrides',()=>{
  const env=mod.localGemmaEnv({PATH:'/bin',OPENAI_API_KEY:'cloud',GEMMA_AGENTIC_API_KEY:'secret',LLAMA_ARG_HOST:'0.0.0.0',CUDA_VISIBLE_DEVICES:'1'});
  assert.equal(env.PATH,'/bin');assert.equal(env.CUDA_VISIBLE_DEVICES,'1');assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.GEMMA_AGENTIC_API_KEY,undefined);assert.equal(env.LLAMA_ARG_HOST,undefined);
});

test('setup starts only after request, deduplicates and waits for model readiness',async()=>{
  const manager=new mod.LocalGemmaManager(root,'installer.py',()=>{});
  const a=manager.setup('python'),b=manager.setup('python');assert.equal(a,b);
  const endpoint=await a;
  assert.match(endpoint,/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  assert.equal(manager.status.phase,'running');assert.equal(calls.length,2);
  assert.equal(await manager.setup('python'),endpoint);assert.equal(calls.length,2);
  manager.stop();assert.equal(manager.status.phase,'idle');
});

test('GPU startup failure retries with CPU and reports CPU mode',async()=>{
  failGpu=true;
  const manager=new mod.LocalGemmaManager(root,'installer.py',()=>{});
  await manager.setup('python');assert.equal(calls.length,3);assert.match(manager.status.message,/CPU/);
  assert.ok(calls[2].args.includes('none'));manager.dispose();
});

test('cancellation stops installer and does not start a server',async()=>{
  stall=true;
  const manager=new mod.LocalGemmaManager(root,'installer.py',()=>{});const controller=new AbortController();
  const pending=manager.setup('python',controller.signal);controller.abort();
  await assert.rejects(pending,/cancelled/);assert.equal(calls.length,1);assert.equal(manager.status.phase,'idle');
});

test('already-cancelled request never spawns',async()=>{
  const manager=new mod.LocalGemmaManager(root,'installer.py',()=>{});const c=new AbortController();c.abort();
  await assert.rejects(manager.setup('python',c.signal),/cancelled/);assert.equal(calls.length,0);
});

test('wrong service on a port cannot count as ready',async()=>{
  const server=http.createServer((req,res)=>res.end(JSON.stringify({data:[{id:'unrelated'}]})));servers.push(server);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  assert.equal(await mod.serverHasModel(server.address().port,'gemma-nonce'),false);
});

test('invalid manifest cannot run relative paths or missing model files',()=>{
  assert.equal(mod.validManifest({...manifest,binary:'./server'}),false);
  assert.equal(mod.validManifest({...manifest,model:path.join(root,'absent')}),false);
  assert.equal(mod.validManifest(manifest),true);
});

test('oversized /v1/models body settles the readiness probe instead of hanging',async()=>{
  const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end('{"data":['+'{"id":"x"},'.repeat(20000)+'{"id":"y"}]}');});
  servers.push(server);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const started=Date.now();
  const ready=await Promise.race([mod.serverHasModel(server.address().port,'gemma-nonce'), new Promise(r=>setTimeout(()=>r('hung'),6000))]);
  assert.equal(ready,false);
  assert.ok(Date.now()-started<5000);
});

test('a server that never finishes the body cannot wedge the probe',async()=>{
  const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.write('{"data":[');/* never ends */});
  servers.push(server);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const ready=await Promise.race([mod.serverHasModel(server.address().port,'gemma-nonce'), new Promise(r=>setTimeout(()=>r('hung'),8000))]);
  assert.equal(ready,false);
});
