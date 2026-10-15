const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { AntigravityImageRuntime } = require('../src/ai/antigravity-image-runtime');
const { ContentMedia, textHash, validMedia } = require('../src/content/content-media');
const { BackgroundMedia } = require('../src/content/background-media');
const { verifyImagePost } = require('../src/platforms/verify-image-post');
const { validateProduct } = require('../src/content/product-config');
const settings = { width:1080,height:1080,max_attempts:3,image_timeout_seconds:30,max_requests_per_day:24 };
function fixture(t) { const root=fs.mkdtempSync(path.join(os.tmpdir(),'meta-image-api-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,input:{id:'new-draft',caption:'Inspect the largest folders first.',brief:{style:'photo',scene:'Organized desktop, natural light'},settings,outputPath:path.join(root,'private','post-images','test.png')}}; }
test('real decoded image is normalized and a completed request is reused on restart',async t=>{
  const f=fixture(t);let calls=0;
  const runner=async(prompt,{cwd,onEvent})=>{calls++;assert.ok(prompt.includes('Do not copy or move'));await sharp({create:{width:700,height:500,channels:3,background:'#8899aa'}}).jpeg().toFile(path.join(cwd,'generated.jpg'));onEvent({event:'step_update',step_update:{tool_name:'generate_image',state:'DONE'}});return {status:'SUCCESS',response:'Generated file',usage:{total_tokens:42}};};
  const result=await new AntigravityImageRuntime({root:f.root,runner}).generate(f.input);assert.equal(result.kind,'ai_image');
  const metadata=await sharp(f.input.outputPath).metadata();assert.equal(metadata.width,1080);assert.equal(metadata.height,1080);assert.equal(metadata.format,'png');
  const restarted=new AntigravityImageRuntime({root:f.root,runner});await restarted.generate({...f.input,brief:{style:'photo',scene:'A changed planning suggestion'}});assert.equal(calls,1);
});
test('CLI success text alone and corrupt raster are not accepted as generated images',async t=>{
  const f=fixture(t);const runner=async(prompt,{cwd,onEvent})=>{fs.writeFileSync(path.join(cwd,'fake.png'),'not an image');onEvent({event:'step_update',step_update:{tool_name:'generate_image',state:'DONE'}});return {status:'SUCCESS',response:'Successfully generated!'};};
  await assert.rejects(new AntigravityImageRuntime({root:f.root,runner}).generate(f.input),/validated generated image/);assert.equal(fs.existsSync(f.input.outputPath),false);
});
test('uncertain request never automatically issues a second generation',async t=>{
  const f=fixture(t);let calls=0;const runner=async()=>{calls++;const error=new Error('timeout');error.code='IMAGE_UNCERTAIN';throw error;};
  const runtime=new AntigravityImageRuntime({root:f.root,runner});await assert.rejects(runtime.generate(f.input),/timeout/);await assert.rejects(runtime.generate(f.input),/needs review/);assert.equal(calls,1);
});
test('daily request limit is persisted across image runtime instances',async t=>{
  const f=fixture(t);let calls=0;const runner=async()=>{calls++;throw new Error('provider unavailable');};
  await assert.rejects(new AntigravityImageRuntime({root:f.root,runner}).generate({...f.input,settings:{...settings,max_requests_per_day:1}}),/unavailable/);
  await assert.rejects(new AntigravityImageRuntime({root:f.root,runner}).generate({...f.input,id:'second',settings:{...settings,max_requests_per_day:1}}),/Daily/);assert.equal(calls,1);
});
test('interrupted generation can recover its existing file without another CLI request',async t=>{
  const f=fixture(t);const runtime=new AntigravityImageRuntime({root:f.root,runner:async()=>{const err=new Error('timeout');err.code='IMAGE_UNCERTAIN';throw err;}});
  await assert.rejects(runtime.generate(f.input));const dir=path.join(f.root,'private','image-jobs',fs.readdirSync(path.join(f.root,'private','image-jobs'))[0]);
  const journal=JSON.parse(fs.readFileSync(path.join(dir,'job.json'),'utf8'));journal.imageToolUsed=true;fs.writeFileSync(path.join(dir,'job.json'),JSON.stringify(journal));
  await sharp({create:{width:600,height:600,channels:3,background:'#123456'}}).png().toFile(path.join(dir,'completed.png'));
  const recovered=await new AntigravityImageRuntime({root:f.root,runner:()=>assert.fail('No duplicate request')}).generate(f.input);assert.equal(recovered.recovered,true);
});
test('AI media preserves captions and falls back to a card only after bounded attempts',async t=>{
  const f=fixture(t);const product=structuredClone(require('./fixtures/product.json'));product.content_media={enabled:true,provider:'antigravity',max_attempts:2,image_fallback:'card'};
  let now=1000;const media=new ContentMedia({root:f.root,now:()=>now,onProgress:()=>{},ai:{callAi:async()=>({style:'photo',scene:'A tidy desk'})},imageRuntime:{generate:async()=>{throw Error('quota');}},renderer:async(html,file,size)=>{await sharp({create:{width:size.width,height:size.height,channels:3,background:'#223344'}}).png().toFile(file);}});
  const post={id:'draft',platform:'threads',text:'Inspect the largest folders first.',status:'needs_media',media:{required:true}};
  await media.prepare(post,product,()=>{});assert.equal(post.status,'needs_media');assert.equal(post.media.attempts,1);assert.equal(post.text,'Inspect the largest folders first.');
  now+=6*60000;await media.prepare(post,product,()=>{});assert.equal(post.media.kind,'content_card');assert.ok(post.media.fallbackReason);assert.ok(validMedia(post,f.root));
});
test('background image preparation returns promptly and rejects stale caption results',async()=>{
  let complete;const media={root:'unused',prepare:async post=>{await new Promise(r=>{complete=r;});post.media={required:true,status:'ready'};post.status='pending';}};
  const worker=new BackgroundMedia(media);const post={id:'draft',text:'Original caption',status:'needs_media',media:{required:true,attempts:0,textHash:textHash('Original caption')}};
  await worker.prepare(post,{content_media:{}},()=>{});assert.ok(worker.active);assert.equal(post.media.attempts,1);
  post.text='Edited caption';post.media={required:true,status:'pending',attempts:0};complete();await worker.active.promise;
  worker.poll({posts:[post]},()=>assert.fail('Stale image must not commit'));assert.equal(post.media.status,'pending');assert.equal(worker.active,null);
});
test('coordinator applies successful background image exactly once and preserves a user hold',async()=>{
  let complete;const media={root:'unused',prepare:async post=>{await new Promise(r=>{complete=r;});post.media={required:true,status:'ready'};post.status='pending';}};
  const worker=new BackgroundMedia(media);const post={id:'draft',text:'Caption',status:'needs_media',media:{required:true,attempts:0,textHash:textHash('Caption')}};let writes=0;
  await worker.prepare(post,{content_media:{}},()=>{});post.status='held';complete();await worker.active.promise;worker.poll({posts:[post]},()=>writes++);worker.poll({posts:[post]},()=>writes++);
  assert.equal(post.media.status,'ready');assert.equal(post.status,'held');assert.equal(writes,1);
});
test('published image requires a canonical permalink and image in the same caption container',async()=>{
  const url='https://www.threads.com/@builder/post/ABC';let nav=0;
  const page={goto:async destination=>{nav++;assert.equal(destination,url);},waitForSelector:async()=>{},evaluate:async()=>[{text:'Checked caption',links:[url],images:[{src:'cdn-image',width:1080,height:1080}]}]};
  const evidence=await verifyImagePost(page,{text:'Checked caption',platform:'threads',postUrl:url},1);assert.equal(evidence.verifiedMediaCount,1);
  await assert.rejects(verifyImagePost(page,{text:'Checked caption',platform:'threads',postUrl:null}),/permalink/);assert.equal(nav,1);
});
test('provider and fallback settings are validated without changing existing post defaults',()=>{
  const product=structuredClone(require('./fixtures/product.json'));assert.throws(()=>validateProduct({...product,content_media:{provider:'unknown'}}),/provider/);assert.throws(()=>validateProduct({...product,content_media:{max_requests_per_day:0}}),/max_requests/);
});
