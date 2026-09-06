import assert from 'node:assert/strict';
import test from 'node:test';
import {Readable} from 'node:stream';
import {createGatewayServer} from '../gateway/core/server.mjs';

test('Chinese and punctuation filenames preview over real HTTP with an ASCII-safe UTF-8 disposition',async t=>{
 let name='周末安排.md';
 const bytes=Buffer.from('# 周末安排\n你好');
 const descriptor=()=>({previewId:'preview_test',revision:0,name,size:bytes.length,delivery:{mode:'text-stream',acceptsRange:false}});
 const runtime={
  createApi:()=>({}),createRealtimeServer:()=>({}),
  auth:{resolveSession:async()=>({actor:{actorId:'test'}})},
  previewHead:async()=>({descriptor:descriptor(),contentType:'text/markdown',contentLength:bytes.length}),
  openPreviewContent:async()=>({contentType:'text/markdown',contentLength:bytes.length,stream:Readable.from([bytes])}),
 };
 const gateway=await createGatewayServer({runtime});
 const address=await gateway.start({port:0}); t.after(()=>gateway.close());
 for(name of ['周末安排.md',"résumé (final)'s 文档.md",'📄'.repeat(180)+'.md']) {
  const response=await fetch(`http://127.0.0.1:${address.port}/api/previews/preview_test/content`,{headers:{authorization:'Bearer test'}});
  assert.equal(response.status,200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  const header=response.headers.get('content-disposition');
  assert.match(header,/^inline; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
  assert.equal(decodeURIComponent(header.split("UTF-8''")[1]),name.slice(0,255).toWellFormed());
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
 }
});
