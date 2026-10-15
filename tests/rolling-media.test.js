const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ContentMedia, validMedia, textHash, checkedBrief, cardHtml } = require('../src/content/content-media');
const { RollingContent } = require('../src/content/rolling-content');
const { ContentEngine } = require('../src/content/content-engine');
const { ContentScheduler } = require('../src/content/content-scheduler');
const { changeQueue } = require('../src/content/content-queue');
const { validateProduct } = require('../src/content/product-config');
const { attachImages } = require('../src/platforms/media-upload');
const NOW = Date.parse('2026-10-12T08:00:00Z');
function png(file, size) { const bytes = Buffer.alloc(32); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes); bytes.write('IHDR',12); bytes.writeUInt32BE(size.width,16); bytes.writeUInt32BE(size.height,20); fs.writeFileSync(file,bytes); }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'meta-rolling-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const product = structuredClone(require('./fixtures/product.json'));
  product.strategy.platforms=['threads','facebook']; product.strategy.post_frequency_hours=2;
  product.schedule={mode:'interval'}; product.content_media={enabled:true}; product.rolling_content={enabled:true};
  let now=NOW, generations=0;
  const state={createdAt:NOW,posts:[],calendar:[],nextPostAt:NOW};
  const ai={callAi:async()=>({ title:'Clear unused files.', points:['Check what you need first.'] })};
  const media = new ContentMedia({root,ai,renderer:async(html,file,size)=>png(file,size),now:()=>now,onProgress:()=>{}});
  const engine=new ContentEngine({ai:{callAi:async()=>{generations++;return {posts:[{text:`Clear unused files. Check folder ${generations} before you delete it.`,type:'value',platform:state.rollingContent.jobs.find(j=>j.status==='generating').platform}]};}},onProgress:()=>{}});
  const rolling=new RollingContent({product,copy:'Teach disk cleanup.',state,engine,media,persist:()=>{},now:()=>now});
  return {root,product,state,media,engine,rolling,generations:()=>generations,time:t=>{now=t;}};
}
function published(id,platform='threads') { return {id,platform,text:'Keep this original.',type:'value',status:'published',publishedAt:NOW,result:{success:true,verified:true}}; }
test('activation preserves old drafts and historical publications; each new publication generates one replacement',async t=>{
  const f=fixture(t); f.state.posts.push(published('old'),{id:'saved',platform:'threads',text:'Preserve me exactly.',type:'value',status:'pending',scheduledAt:NOW+20*3600000});
  const originals=structuredClone(f.state.posts); f.rolling.initialize();
  assert.equal((await f.rolling.tick()).status,'idle');
  f.state.posts.push(published('new-threads'),published('new-facebook','facebook'));
  await f.rolling.tick(); await f.rolling.tick(); await f.rolling.tick();
  assert.equal(f.generations(),2); assert.equal(f.state.posts.filter(p=>p.triggerId).length,2);
  assert.deepEqual(f.state.posts.slice(0,2).map(p=>[p.id,p.text,p.status,p.media]),originals.map(p=>[p.id,p.text,p.status,p.media]));
  for (const post of f.state.posts.filter(p=>p.triggerId)) { assert.equal(post.status,'pending');assert.ok(validMedia(post,f.root)); }
  assert.ok(f.state.posts.find(p=>p.triggerId==='new-threads').scheduledAt > f.state.posts.find(p=>p.id==='saved').scheduledAt);
});
test('failed images preserve checkpointed caption; restart retries media without generating duplicate text',async t=>{
  const f=fixture(t); f.rolling.initialize(); f.state.posts.push(published('new'));
  f.media.renderer=async()=>{throw new Error('render unavailable');};
  await f.rolling.tick(); const draft=f.state.posts.find(p=>p.triggerId); const text=draft.text;
  assert.equal(draft.status,'needs_media');assert.equal(draft.media.attempts,1);
  const restarted=new RollingContent({...f.rolling,state:JSON.parse(JSON.stringify(f.state))});
  f.time(NOW+6*60000); await restarted.tick(); assert.equal(f.generations(),1);
  assert.equal(restarted.state.posts.at(-1).text,text);assert.equal(restarted.state.posts.at(-1).media.attempts,2);
  f.time(NOW+12*60000);await restarted.tick(); f.time(NOW+18*60000);await restarted.tick();
  assert.equal(restarted.state.posts.at(-1).media.attempts,3);assert.equal(restarted.state.posts.at(-1).status,'needs_media');
});
test('uncertain or simulated publication does not generate and due posts have priority',async t=>{
  const f=fixture(t);f.rolling.initialize();f.state.posts.push({...published('sim'),result:{success:true,verified:true,simulated:true}});
  await f.rolling.tick();assert.equal(f.generations(),0);
  f.state.posts.push({...published('unknown'),status:'needs_review'});assert.equal((await f.rolling.tick()).status,'blocked');
  f.state.posts.pop();f.state.posts.push(published('new'),{id:'due',platform:'facebook',status:'pending',scheduledAt:NOW,text:'Read the list.',type:'value'});
  assert.equal((await f.rolling.tick()).status,'waiting');assert.equal(f.generations(),0);
});
test('campaign maximum caps new jobs without deleting saved content',async t=>{
  const f=fixture(t);f.rolling.initialize();f.state.posts.push(published('new'));f.state.learning={settings:{max_campaign_posts:1}};
  assert.equal((await f.rolling.tick()).status,'complete');assert.equal(f.state.posts.length,1);assert.equal(f.generations(),0);
});
test('image caption integrity, file tampering and external paths are checked',async t=>{
  const f=fixture(t);const p={id:'image',text:'Clear unused files. Check what you need first.',platform:'threads',status:'needs_media',media:{required:true}};
  await f.media.prepare(p,f.product,()=>{});assert.ok(validMedia(p,f.root));
  p.text+=' Edit.';assert.equal(validMedia(p,f.root),false);p.text=p.text.replace(' Edit.','');
  fs.appendFileSync(p.media.path,'tampered');assert.equal(validMedia(p,f.root),false);
  p.media.path=path.join(f.root,'outside.png');png(p.media.path,p.media);assert.equal(validMedia(p,f.root),false);
});
test('AI image brief rejects new claims and HTML is escaped',()=>{
  assert.throws(()=>checkedBrief({title:'10x faster',points:['Guaranteed results']},'Clean your disk.'),/excerpt/);
  const html=cardHtml({title:'<script>',points:['<img src="https://evil">']},{width:1080,height:1080},'facebook');
  assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<img'));
});
test('image retries have explicit text-only fallback and manual retry never resets publications',async t=>{
  const f=fixture(t);f.product.content_media={enabled:true,max_attempts:1,text_only_fallback:true};f.media.renderer=async()=>{throw new Error('no renderer');};
  const p={id:'draft',platform:'threads',text:'Check what you need first.',type:'value',status:'needs_media',scheduledAt:NOW,media:{required:true}};
  await f.media.prepare(p,f.product,()=>{});assert.equal(p.status,'pending');assert.equal(p.media.status,'text_only');
  f.state.posts=[p];const retried=changeQueue(f.state,f.product,{kind:'retry-media',id:'draft'},NOW);
  assert.equal(retried.state.posts[0].media.attempts,0);assert.equal(retried.state.posts[0].text,p.text);
  f.state.posts=[{...p,status:'needs_review',attemptedAt:NOW}];assert.throws(()=>changeQueue(f.state,f.product,{kind:'retry-media',id:'draft'},NOW),/Reconcile/);
});
test('manual caption edit invalidates its image; scheduler holds missing media before any browser submission',async t=>{
  const f=fixture(t);const p={id:'draft',platform:'threads',text:'Check what you need first.',type:'value',status:'pending',scheduledAt:NOW,media:{required:true,status:'ready',attempts:3,textHash:textHash('Check what you need first.')}};
  f.state.posts=[p];const edited=changeQueue(f.state,f.product,{kind:'edit',id:'draft',text:'Read your file list carefully.'},NOW);
  assert.equal(edited.state.posts[0].status,'needs_media');assert.equal(edited.state.posts[0].media.attempts,0);
  const scheduler=new ContentScheduler({product:f.product,state:f.state,now:()=>NOW,persist:()=>{},mediaRoot:f.root,publish:()=>assert.fail('Missing image must not publish')});
  const result=await scheduler.tick({dryRun:false});assert.equal(result.status,'held');assert.equal(p.status,'needs_media');assert.equal(p.attemptedAt,undefined);
});
test('new content checkpoint happens before rendering; no old text-only draft gets media',async t=>{
  const f=fixture(t);let checkpoint, checked=false;
  f.media.renderer=async(html,file,size)=>{assert.equal(checkpoint[0].text,'Check the file list first.');checked=true;png(file,size);};
  const engine=new ContentEngine({ai:{callAi:async()=>({posts:[{text:'Check the file list first.',type:'value',platform:'threads'}]})},mediaEngine:f.media,onProgress:()=>{}});
  const posts=await engine.generateContentQueue(f.product,'',1,{onAccepted:async drafts=>{checkpoint=structuredClone(drafts);}});
  assert.ok(checked);assert.equal(posts[0].status,'pending');assert.ok(validMedia(posts[0],f.root));
  assert.throws(()=>validateProduct({...f.product,content_media:{max_attempts:0}}),/max_attempts/);
});
test('upload requires a new image preview and never silently falls back when input or upload is unavailable',async t=>{
  const f=fixture(t);const file=path.join(f.root,'image.png');png(file,{width:1080,height:1080});
  const missing={waitForFunction:async()=>{},evaluate:async()=>[], $:async()=>null};
  await assert.rejects(attachImages(missing,[file]),/file input/);
  let uploaded=false, waited=false;
  const page={...missing,$:async()=>({uploadFile:async(...files)=>{uploaded=true;assert.deepEqual(files,[file]);}}),waitForFunction:async(fn,opts,selector,before,count)=>{if(opts.timeout===20000)return;waited=true;assert.equal(count,1);assert.equal(opts.timeout,45000);}};
  assert.deepEqual(await attachImages(page,[file]),{attached:1});assert.ok(uploaded&&waited);
  page.waitForFunction=async()=>{throw new Error('upload timeout');};await assert.rejects(attachImages(page,[file]),/timeout/);
});
