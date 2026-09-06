import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import ts from 'typescript';
const source=await fs.readFile(new URL('../app/easywork/features/conversation/ConversationView.tsx',import.meta.url),'utf8');
function handler(name,next,{status,capabilities}={}) {
 const start=source.indexOf(`const ${name}:`),end=source.indexOf(`const ${next}`,start);
 assert.ok(start>=0 && end>start);
 const javascript=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const calls=[];
 const callback=new Function('tasks','effectiveAgentOptions','selectedAgent','api','commandId','fetchTaskSummary','setTasks','notify',`${javascript};return ${name};`)(
  {t:{id:'t',status,route:{agentId:'claude-code'}}},
  capabilities ? [{agentId:'claude-code',runtimeCapabilities:capabilities}]:[],
  undefined,{post:async(...args)=>calls.push(args)},()=> 'test-command',async()=>({id:'t',status:'running'}),()=>{},()=>{},
 );
 return {callback,calls};
}
for(const [name,next,status,operation,arg] of [
 ['respondApproval','respondInput','waiting_approval','respondApproval','approve'],
 ['respondInput','saveWorkDraft','waiting_input','respondInput',{q:'answer'}],
]) test(`${operation}: a live pending request survives an empty setup cache; unsupported idle actions stay blocked`,async()=>{
 const active=handler(name,next,{status});
 await active.callback('t','pending-request',arg);
 assert.equal(active.calls.length,1);
 assert.equal(active.calls[0][1].requestId,'pending-request');
 const idle=handler(name,next,{status:'completed',capabilities:{[operation]:{availability:'unavailable',reason:'unsupported'}}});
 await assert.rejects(()=>idle.callback('t','no-request',arg),/unsupported/);
 assert.equal(idle.calls.length,0);
});
