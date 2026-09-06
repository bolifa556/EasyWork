import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkArtifactCards } from '../app/easywork/features/conversation/artifact-markdown.mjs';
import { artifactAnswerMarkdown, artifactDisplayName, conversationArtifactCards, referencedArtifactCards } from '../app/easywork/features/conversation/artifact-presentation.mjs';
import { parseRemoteArtifactLinks } from '../shared/remote-artifact-links.mjs';
import { canPreviewFile } from '../shared/file-preview.mjs';
import { createAgentState, createReducerContext } from '../gateway/core/agents/contract.mjs';
import { emitLinkedRemoteArtifacts } from '../gateway/core/agents/common.mjs';

const a = {id:'artifact-a',name:'周末安排.md',path:'/work/周末安排.md',lifecycle:'active',createdAt:'2026-09-05',mime:'application/octet-stream',size:1038};
const b = {...a,id:'artifact-b',name:'比第一个更长的文件名.txt',path:'/work/比第一个更长的文件名.txt'};
const link = (card,label=card.name) => `[${label}](file://${encodeURI(card.path)})`;
function render(source,cards=[a]) {
 return renderToStaticMarkup(React.createElement(Markdown,{
  remarkPlugins:[remarkGfm,[remarkArtifactCards,{cards}]],
  components:{div:({node,children}) => {
   const id=node.properties['data-artifact-id'];
   return id ? React.createElement('article',{'data-artifact-id':id},cards.find(c=>c.id===id).name) : React.createElement('div',{},children);
  }},
 },source));
}

test('cards replace original links between surrounding paragraphs without stray icons or a second footer',()=>{
 const html=render(`文件已确认存在。\n\n📄 **${link(a)}**\n\n这就是之前创建的周末安排文档。`);
 assert.match(html,/<p>文件已确认存在。<\/p>\s*<article[^>]*>周末安排.md<\/article>\s*<p>这就是之前创建的周末安排文档。<\/p>/);
 assert.equal((html.match(/<article/g)||[]).length,1);
 assert.doesNotMatch(html,/📄|file:\/\/|<p><article/);
});

test('inline links lift to separate blocks and preserve emphasis and unrelated emoji',()=>{
 const html=render(`🎵 正文有图标。\n\n前半段 **文字 📎 ${link(a)} 后半段**，继续。`);
 assert.match(html,/<p>前半段 <strong>文字<\/strong><\/p>\s*<article/);
 assert.match(html,/<\/article>\s*<p><strong> 后半段<\/strong>，继续。<\/p>/);
 assert.match(html,/🎵 正文有图标/); assert.doesNotMatch(html,/📎/);
 assert.doesNotMatch(render(`**📄**${link(a)}⬇️`),/📄|⬇|️|<strong><\/strong>/);
});

test('multiple files, lists, references, encoded parentheses and tables retain order and valid block structure',()=>{
 const c={...a,id:'c',name:'a(b).txt',path:'/work/a(b).txt'};
 const html=render(`先看：\n\n- 📄 ${link(a)}\n- ${link(b)}\n\n最后一个 [报告][r]\n\n[r]: file:///work/a(b).txt\n\n| 文件 | 用途 |\n| --- | --- |\n| ${link(a)} | 计划 |`,[a,b,c]);
 assert.equal((html.match(/<article/g)||[]).length,4);
 assert.ok(html.indexOf('artifact-a')<html.indexOf('artifact-b') && html.indexOf('artifact-b')<html.indexOf('data-artifact-id="c"'));
 assert.match(html,/<td><article/); assert.doesNotMatch(html,/📄|<p><article/);
});

test('code, web links and a different path with the same filename are never converted by filename guessing',()=>{
 const html=render('`'+link(a)+'`\n\n```md\n'+link(a)+'\n```\n\n[网页](https://example.org/)\n\n**[周末安排.md](file:///different/周末安排.md)**');
 assert.match(html,/<code>\[周末安排.md\]/);
 assert.match(html,/https:\/\/example.org\//);
 assert.equal((html.match(/<article/g)||[]).length,1); // Unlinked artifact remains accessible once.
 assert.match(html,/<strong><a[^>]*>周末安排.md<\/a><\/strong>/);
});

test('historical final Markdown recovers exact link positions and rejects intermediate or unrelated messages',()=>{
 const original=`前文\n\n📄 ${link(a)}\n\n后文`;
 const historical='前文\n\n📄\n\n后文';
 const events=[{kind:'message',payload:{event:{role:'assistant',text:original,delta:false}}}];
 assert.equal(artifactAnswerMarkdown(historical,events),original);
 assert.equal(artifactAnswerMarkdown('这是另一条消息',events),'这是另一条消息');
 assert.equal(artifactAnswerMarkdown(historical,[{kind:'message',payload:{text:original,delta:true}}]),historical);
 const final={kind:'final',payload:{event:{text:parseRemoteArtifactLinks(original).cleaned,artifactMarkdown:original}}};
 assert.equal(artifactAnswerMarkdown(final.payload.event.text,[final]),original);
});

test('new final events carry original Markdown only for the matching final across all adapters',()=>{
 for(const adapter of ['codex','claude-code','opencode']) {
  const context=createReducerContext(createAgentState(adapter),{adapter,protocol:'test'});
  const original=`前文\n\n📄 ${link(a)}\n\n后文`;
  const cleaned=emitLinkedRemoteArtifacts(context,original);
  assert.doesNotMatch(cleaned,/📄|file:\/\//);
  assert.equal(context.emit('final','completed',{text:cleaned}).payload.artifactMarkdown,original);
  assert.equal(context.emit('final','completed',{text:'另一个回合'}).payload.artifactMarkdown,undefined);
 }
});

test('artifact matching uses full paths and preserves capture failures without reviving deleted artifacts',()=>{
 const events=[a,b].map(x=>({kind:'artifact',eventId:x.id,payload:{event:{path:x.path,artifactId:x.id,artifact:x}}}));
 const cards=conversationArtifactCards(events,[{...a,lifecycle:'deleted'},b]);
 assert.deepEqual(cards.map(x=>[x.id,x.path]),[[b.id,b.path]]);
 const failed=conversationArtifactCards([{kind:'artifact',eventId:'f',payload:{path:a.path,name:a.name,failure:{message:'文件已变化'}}}]);
 assert.equal(failed[0].failure,'文件已变化');assert.match(render(link(a),failed),/failed:f/);
});

test('preview eligibility shares the workspace formats and does not offer binary office/archive/media previews',()=>{
 for (const name of ['a.md','a.txt','a.json','a.csv','a.tsv','a.pdf','a.png','a.py','README']) assert.equal(canPreviewFile({name}),true,name);
 for (const name of ['a.zip','a.docx','a.xlsx','a.mp3','a.bin']) assert.equal(canPreviewFile({name}),false,name);
 assert.equal(canPreviewFile({name:'data.custom',mime:'application/vnd.test+json'}),true);
});

test('full filenames retain spaces and emoji, and icon-only legacy replies recover their source',()=>{
 assert.equal(artifactDisplayName('下周 学习计划.md'),'下周 学习计划.md');
 assert.equal(artifactDisplayName('📄 中文 report.txt'),'📄 中文 report.txt');
 const original='📄 '+link(a);
 assert.equal(artifactAnswerMarkdown('📄',[{kind:'message',payload:{role:'assistant',text:original,delta:false}}]),original);
});

test('repeat delivery registers every file in each answer even with persistent adapter state',()=>{
 const context=createReducerContext(createAgentState('claude-code'),{adapter:'claude-code',protocol:'test'});
 emitLinkedRemoteArtifacts(context,link(a));
 context.events.length=0;
 emitLinkedRemoteArtifacts(context,link(b)+'\n'+link(a)+'\n'+link(a));
 assert.deepEqual(context.events.map(e=>e.payload.path),[b.path,a.path]);
});

test('historical repeated deliveries reuse only an earlier exact path in the same workspace',()=>{
 const history=[{...a,workspaceId:'w'},{...a,id:'wrong-workspace',workspaceId:'other'},{...a,id:'future',workspaceId:'w',createdAt:'2027'}];
 assert.deepEqual(referencedArtifactCards(link(a)+link(b),[b],history,{workspaceId:'w',before:'2026-09-06'}).map(c=>c.id),[b.id,a.id]);
 assert.deepEqual(referencedArtifactCards(link(a),[],history,{workspaceId:'missing',before:'2026-09-06'}),[]);
 assert.deepEqual(referencedArtifactCards(link(a),[{...a,failure:'changed'}],history,{workspaceId:'w',before:'2026-09-06'}).map(c=>c.failure),['changed']);
});
