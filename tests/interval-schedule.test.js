const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ContentScheduler } = require('../src/content/content-scheduler');
const { changeQueue } = require('../src/content/content-queue');
const { ContentPlanner } = require('../src/content/content-planner');
const timing = require('../src/content/interval-schedule');
const HOUR = 3600000, NOW = Date.parse('2026-10-12T08:00:00Z');
const product = { ...structuredClone(require('./fixtures/product.json')), strategy: { ...require('./fixtures/product.json').strategy, post_frequency_hours: 2 }, schedule: { mode: 'interval' } };
const draft = (id, platform, scheduledAt = NOW + 20 * HOUR) => ({ id, platform, type: 'value', status: 'pending', text: `Ask your audience about task ${id}.`, scheduledAt });
const published = (id, platform, time) => ({ ...draft(id,platform), status:'published', publishedAt:time, result:{ success:true, verified:true } });
function fixture(posts, time=NOW) {
  let now=time;
  const state={posts,createdAt:NOW-HOUR,cursor:0,nextPostAt:NOW,calendar:[],learning:{endAt:NOW-HOUR,nextMetricsAt:NOW+HOUR,settings:{slot_grace_minutes:30}}};
  let sends=0;
  const scheduler=new ContentScheduler({ product,state,persist:()=>{},now:()=>now,publish:async()=>{sends++;now+=1000;return {success:true,verified:true};} });
  return {scheduler,state,sends:()=>sends,setTime:t=>{now=t;}};
}

test('returning online after yesterday publishes one post on all four platforms then rebases every remaining interval', async t => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'four-platform-resume-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'private', 'post-images'); fs.mkdirSync(dir, { recursive: true });
  const image = path.join(dir, 'fixture.png');
  const bytes = await require('sharp')({ create: { width: 400, height: 400, channels: 3, background: '#663399' } }).png().toBuffer();
  fs.writeFileSync(image, bytes);
  const { textHash } = require('../src/content/content-media');
  const platforms = ['threads', 'facebook', 'x', 'instagram'];
  const configured = { ...structuredClone(product), strategy: { ...product.strategy, platforms } };
  const posts = platforms.map(p => published(`old-${p}`, p, NOW - 24 * HOUR));
  for (let slot = 0; slot < 3; slot++) for (const p of platforms) posts.push(draft(`${slot}-${p}`, p));
  const f = fixture(posts);
  f.scheduler.product = configured;
  f.scheduler.mediaRoot = root;
  for (const post of posts.filter(p => p.platform === 'instagram' && p.status === 'pending')) post.media = { required: true, status: 'ready', path: image, width: 400, height: 400, textHash: textHash(post.text), fileHash: textHash(bytes) };
  const originalTexts = posts.map(p => [p.id, p.text]);
  const resume = timing.resumeIntervalQueue(f.state, configured, NOW);
  assert.deepEqual(resume.duePlatforms, platforms);
  for (const platform of platforms) assert.equal((await f.scheduler.tick({ dryRun: false })).post.platform, platform);
  assert.equal(f.sends(), 4);
  assert.equal((await f.scheduler.tick({ dryRun: false })).status, 'waiting');
  for (const platform of platforms) {
    const last = timing.lastPublished(f.state, platform);
    const pending = f.state.posts.filter(p => p.platform === platform && p.status === 'pending');
    assert.deepEqual(pending.map(p => p.scheduledAt), [last + 2 * HOUR, last + 4 * HOUR]);
  }
  assert.deepEqual(posts.map(p => [p.id, p.text]), originalTexts);
  const unchanged = timing.resumeIntervalQueue(f.state, configured, NOW + HOUR);
  assert.equal(unchanged.status, 'on_schedule');
  assert.deepEqual(unchanged.duePlatforms, []);
  assert.equal(timing.hasDuePosts(f.state, configured, NOW + HOUR), false);
});
test('interval mode ignores old fixed slots and uses each platforms actual last publication', async()=>{
  const f=fixture([published('a','threads',NOW-HOUR),published('b','facebook',NOW-3*HOUR),draft('1','threads'),draft('2','facebook')]);
  assert.equal((await f.scheduler.tick({dryRun:false})).post.platform,'facebook');
  assert.equal((await f.scheduler.tick({dryRun:false})).status,'waiting');
  f.setTime(NOW+HOUR);
  assert.equal((await f.scheduler.tick({dryRun:false})).post.platform,'threads');
});
test('a long offline period publishes once per platform and restarts timers without a backlog burst',async()=>{
  const f=fixture([published('a','threads',NOW-48*HOUR),published('b','facebook',NOW-48*HOUR),draft('1','threads'),draft('2','facebook'),draft('3','threads'),draft('4','facebook')]);
  await f.scheduler.tick({dryRun:false});await f.scheduler.tick({dryRun:false});
  assert.equal((await f.scheduler.tick({dryRun:false})).status,'waiting');
  assert.equal(f.sends(),2);
  const restarted=new ContentScheduler({product,state:structuredClone(f.state),now:()=>NOW+HOUR,persist:()=>{},publish:()=>assert.fail('Too early after restart')});
  assert.equal((await restarted.tick({dryRun:false})).status,'waiting');
  assert.ok(restarted.getNextPostTime().getTime()>=NOW+2*HOUR);
});
test('first posts are immediately due and successful completion anchors the next interval',async()=>{
  const f=fixture([draft('1','threads'),draft('2','facebook'),draft('3','threads')]);
  await f.scheduler.tick({dryRun:false});await f.scheduler.tick({dryRun:false});
  assert.equal(f.state.posts[0].publishedAt,NOW+1000);
  f.setTime(NOW+2*HOUR);
  assert.equal((await f.scheduler.tick({dryRun:false})).status,'waiting');
  f.setTime(NOW+2*HOUR+1000);
  assert.equal((await f.scheduler.tick({dryRun:false})).status,'published');
});
test('preview preserves every draft and uncertain publication blocks automatic retries',async()=>{
  const f=fixture([draft('1','threads')]);const before=JSON.stringify(f.state);
  assert.equal((await f.scheduler.tick()).status,'preview');assert.equal(JSON.stringify(f.state),before);
  f.state.posts[0].status='needs_review';
  await assert.rejects(f.scheduler.tick({dryRun:false}),/reconcile/);
  assert.equal(f.sends(),0);
});
test('manual postponement remains effective and does not block the other platform',async()=>{
  const f=fixture([draft('1','threads'),draft('2','facebook')]);
  const result=changeQueue(f.state,product,{kind:'reschedule',id:'1',at:new Date(NOW+5*HOUR).toISOString()},NOW);
  Object.assign(f.state,result.state);
  assert.equal((await f.scheduler.tick({dryRun:false})).post.platform,'facebook');
  assert.equal((await f.scheduler.tick({dryRun:false})).nextPostAt,NOW+5*HOUR);
});
test('interval projections preserve content and do not enforce old four-slot daily limits',async()=>{
  const f=fixture(Array.from({length:5},(_,i)=>published(`old${i}`,'threads',NOW-(5-i)*2*HOUR)).concat(draft('new','threads')));
  const before=f.state.posts.map(p=>[p.id,p.text]);
  assert.equal((await f.scheduler.tick({dryRun:false})).status,'published');
  assert.deepEqual(f.state.posts.map(p=>[p.id,p.text]),before);
});
test('adaptive batches use two-hour platform spacing instead of clock slots',()=>{
  const state={posts:[published('1','threads',NOW-48*HOUR),published('2','facebook',NOW-48*HOUR)],learning:{batch:0,endAt:NOW-HOUR,settings:{max_campaign_posts:180,next_batch_size:10,observation_age_hours:24,minimum_mature_posts_per_platform:2}}};
  state.posts.forEach(p=>p.batch=0);
  const planner=new ContentPlanner({product,state,now:()=>NOW});
  const plan=planner.plan();assert.equal(plan.status,'ready');assert.equal(plan.slots.length,10);
  assert.equal(plan.slots[0],NOW);assert.equal(plan.slots[2],NOW+2*HOUR);
});
test('a verified publication missing its time requires reconciliation',()=>{
  assert.throws(()=>timing.lastPublished({posts:[published('old','threads',undefined)]},'threads'),/Missing actual publication time/);
});

test('new interval campaigns start immediately and retain pilot quantity without fixed slots',async t=>{
  const fs=require('fs'),os=require('os'),path=require('path');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'interval-setup-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'product.json'),JSON.stringify({...product,writing:{humanizer_enabled:false},research:{enabled:false}}));
  const state=await require('../src/agent/setup-engine').setup(root,{now:NOW,clock:()=>NOW,engine:{generateContentQueue:async(p,c,n,o)=>o.plan.map((a,i)=>draft(String(i),a.platform))}});
  assert.equal(state.posts.length,40);
  assert.equal(state.posts[0].scheduledAt,NOW);
  assert.equal(state.posts[1].scheduledAt,NOW);
  assert.equal(state.posts[2].scheduledAt,NOW+2*HOUR);
  assert.ok(fs.readFileSync(path.join(root,'knowledge/product/strategy.md'),'utf8').includes('Interval schedule'));
});

 test('a running scheduler adopts one-hour intervals independently without replacing saved drafts', async()=>{
  const f=fixture([published('a','threads',NOW-45*60000),published('b','facebook',NOW-20*60000),draft('1','threads'),draft('2','facebook')]);
  f.scheduler.product=structuredClone(product);
  const saved=f.state.posts.map(p=>[p.id,p.text,p.status]);
  assert.equal(f.scheduler.getNextPostTime().getTime(),NOW+75*60000);
  f.scheduler.product.strategy.post_frequency_hours=1;
  assert.equal(f.scheduler.getNextPostTime().getTime(),NOW+15*60000);
  assert.equal((await f.scheduler.tick({dryRun:false})).status,'waiting');
  assert.deepEqual(f.state.posts.map(p=>[p.id,p.text,p.status]),saved);
  f.setTime(NOW+15*60000);
  assert.equal((await f.scheduler.tick({dryRun:false})).post.platform,'threads');
  assert.equal((await f.scheduler.tick({dryRun:false})).nextPostAt,NOW+40*60000);
  f.setTime(NOW+40*60000);
  assert.equal((await f.scheduler.tick({dryRun:false})).post.platform,'facebook');
  assert.equal(f.sends(),2);
 });

test('confirmed pre-submission failure backs off while another platform publishes', async () => {
  const f = fixture([draft('first','threads'), draft('other','facebook'), draft('later','threads')]);
  let attempts = 0;
  f.scheduler.publish = async post => { attempts++; return post.platform === 'threads' ? { success: false, submitted: false, reason: 'Composer loading' } : { success: true, verified: true }; };
  assert.equal((await f.scheduler.tick({dryRun:false})).status, 'retry_scheduled');
  assert.equal(f.state.posts[0].status, 'pending');
  assert.equal(f.state.posts[0].notBefore, NOW + 120000);
  assert.equal((await f.scheduler.tick({dryRun:false})).post.platform, 'facebook');
  assert.equal((await f.scheduler.tick({dryRun:false})).status, 'waiting');
  assert.equal(attempts, 2);
  f.setTime(NOW + 120000);
  assert.equal((await f.scheduler.tick({dryRun:false})).status, 'retry_scheduled');
  assert.equal(f.state.posts[0].publishRetries, 2);
});

test('a submit checkpoint forbids retry even when publisher claims submitted=false', async () => {
  const f = fixture([draft('first','threads')]);
  f.scheduler.publish = async (_, __, onSubmission) => { onSubmission(); return { success:false, submitted:false }; };
  await assert.rejects(f.scheduler.tick({dryRun:false}), /review/);
  assert.equal(f.state.posts[0].status, 'needs_review');
});
