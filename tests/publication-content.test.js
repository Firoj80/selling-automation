const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {publicationContent}=require('../src/content/publication-content');
const base=structuredClone(require('./fixtures/product.json'));
base.strategy.platforms=['threads','facebook','x','instagram'];base.publishing={disabled_platforms:['x'],promote_every_post:true};
for(const platform of ['threads','facebook','instagram'])test('promotion preserves source caption and places product on '+platform,()=>{
 const post={id:'draft',platform,type:'value',manuallyEdited:true,text:'Check the largest folders before deleting files.',media:{required:true,status:'ready',textHash:'unchanged'}};
 const original=structuredClone(post),out=publicationContent(post,base);
 assert.deepEqual(post,original);assert.equal(out.type,'product');assert.ok(!out.text.includes('\u2014'));
 if(platform==='threads'){assert.equal(out.text,post.text);assert.ok(out.threadReply.includes(base.product.sales_url));assert.ok(out.threadReply.includes('\n'));assert.ok(!out.threadReply.includes('\\n'));}
 else {assert.ok(out.text.includes(base.product.name));assert.ok(out.text.startsWith(post.text));if(platform==='facebook')assert.ok(out.text.includes(base.product.sales_url));else assert.match(out.text,/Check bio for link/);}
});
test('promotion is optional and its management setting validates booleans',()=>{assert.equal(publicationContent({text:'test'},{}),null);const {changedProduct}=require('../src/content/config-management');assert.equal(changedProduct(base,'publishing.promote_every_post',false).publishing.promote_every_post,false);assert.throws(()=>changedProduct(base,'publishing.promote_every_post','true'),/boolean/);});
test('durable state save retains a valid last-good snapshot and does not overwrite it with corruption',t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'durable-state-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'state.json'),{save}=require('../src/content/content-store');save(file,{n:1});save(file,{n:2});assert.deepEqual(JSON.parse(fs.readFileSync(file+'.last-good')),{n:1});fs.writeFileSync(file,Buffer.alloc(20));save(file,{n:3});assert.deepEqual(JSON.parse(fs.readFileSync(file+'.last-good')),{n:1});assert.deepEqual(JSON.parse(fs.readFileSync(file)),{n:3});});

test('scheduler persists outgoing promotion separately before sending an edited draft',async()=>{
 const {ContentScheduler}=require('../src/content/content-scheduler');const product=structuredClone(base);product.schedule={mode:'interval'};
 const state={posts:[{id:'edited',platform:'facebook',type:'value',status:'pending',text:'Check the largest folders before deleting files.',manuallyEdited:true}],createdAt:0,nextPostAt:0};
 let saved;const scheduler=new ContentScheduler({product,state,now:()=>1000,persist:s=>{saved=structuredClone(s)},publish:async post=>{assert.equal(saved.posts[0].submission.state,'preparing');assert.ok(post.publication.text.includes(product.product.sales_url));assert.equal(post.text,'Check the largest folders before deleting files.');return{success:true,verified:true}}});
 assert.equal((await scheduler.tick({dryRun:false})).status,'published');
});

test('quarantining an uncertain submission retains its evidence and releases only that platform hold',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'quarantined-post-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const {save}=require('../src/content/content-store'),file=path.join(dir,'private/product-content.json');const result={success:false,reason:'Connection lost after submit'};
 save(file,{posts:[{id:'old',platform:'facebook',status:'needs_review',result,submission:{state:'may_have_submitted'}},{id:'next',platform:'facebook',status:'pending'}],createdAt:0,nextPostAt:0,recovery:{platformHolds:{facebook:{postIds:['old']},threads:{postIds:['other']}}}});
 require('../src/content/content-recovery').reconcile(dir,{id:'old',action:'quarantine'});const state=JSON.parse(fs.readFileSync(file));assert.equal(state.posts[0].status,'held');assert.deepEqual(state.posts[0].result,result);assert.equal(state.posts[0].submission.state,'may_have_submitted');assert.equal(state.posts[1].status,'pending');assert.equal(state.recovery.platformHolds.facebook,undefined);assert.ok(state.recovery.platformHolds.threads);
});

test('unreadable engagement state blocks loading instead of silently resetting action history',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'corrupt-history-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'state.json');fs.writeFileSync(file,Buffer.alloc(64));
 const script=`const config=require('./config');config.STATE_FILE=process.argv[1];require('./src/storage/state-store');`;
 const child=require('child_process').spawnSync(process.execPath,['-e',script,file],{cwd:path.resolve(__dirname,'..'),encoding:'utf8'});assert.notEqual(child.status,0);assert.match(child.stderr,/Saved engagement state is unreadable/);assert.equal(fs.readFileSync(file).every(b=>b===0),true);
});

test('promotion mode reports selling enabled and counts promoted publications as product posts',()=>{
 const {ContentTracker}=require('../src/content/content-tracker');const state={posts:[{platform:'threads',type:'value',publication:{type:'product'},status:'published',publishedAt:1,result:{verified:true,postUrl:'https://www.threads.com/@seller/post/ABC'}}]};const tracker=new ContentTracker({product:base,state});assert.equal(tracker.getProductMentionRatio('threads').productPosts,1);assert.equal(tracker.shouldPublishProductForPlatform('threads'),true);assert.equal(tracker.getSellingStatus().threads.publishedValuePosts,0);
});

test('promotion mode sends due content without waiting on historical metrics',async()=>{
 const {ContentScheduler}=require('../src/content/content-scheduler');const state={posts:[{id:'due',platform:'facebook',type:'value',manuallyEdited:true,status:'pending',text:'Check the largest folders before deleting files.'}],createdAt:0,nextPostAt:0,learning:{nextMetricsAt:0,endAt:99999999}};
 const product={...base,schedule:{mode:'interval'}};const scheduler=new ContentScheduler({product,state,now:()=>1000,persist:()=>{},tracker:{refresh:()=>assert.fail('Historical metrics must not block due promotion'),shouldPublishProductForPlatform:()=>true},publish:async()=>({success:true,verified:true})});assert.equal((await scheduler.tick({dryRun:false})).status,'published');
});
