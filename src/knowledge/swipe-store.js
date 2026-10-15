const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { save } = require('../content/content-store');
const { canonicalPostUrl } = require('../content/post-metrics');
const { evidenceUrl } = require('./evidence-url');
const DAY = 86400000;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const textHash = text => digest(text.toLowerCase().replace(/\s+/g, ' ').trim());

// Callers hold the shared campaign lock across observation and synthesis.
class SwipeStore {
  constructor({ root, fingerprint, now = () => Date.now() }) {
    Object.assign(this, { root, fingerprint, now });
    this.file = path.join(root, 'knowledge/learning/swipe_file.json');
  }
  read() {
    if (!fs.existsSync(this.file)) return { version: 1, fingerprint: this.fingerprint, records: [] };
    if (fs.statSync(this.file).size > 2000000) throw new Error('Swipe file exceeds its storage budget');
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.records)) throw new Error('Invalid swipe file; preserve it for review before retrying');
    if (data.fingerprint !== this.fingerprint) throw new Error('Swipe file belongs to different product inputs; archive it before learning for another product');
    if (data.records.length > 500 || data.records.some(r => !r || !r.url || evidenceUrl(r.url, r.platform) !== r.url || r.id !== digest(r.url).slice(0, 24) || typeof r.content !== 'string' || r.content.length > 1200 || typeof r.author !== 'string' || !r.author || typeof r.contentHash !== 'string' || !Number.isFinite(r.firstSeenAt) || !Number.isFinite(r.observedAt) || (r.recordType === 'comment' && (!r.parentUrl || canonicalPostUrl(r.parentUrl, r.platform) !== r.parentUrl)))) throw new Error('Invalid swipe records; preserve the file for review');
    return { ...data, records: data.records.filter(r => Number.isFinite(r.firstSeenAt) && r.firstSeenAt >= this.now() - 30 * DAY) };
  }
  known(item) {
    const hash = textHash(item.text);
    return this.read().records.some(r => r.url === item.url || r.contentHash === hash);
  }
  add(item, topicIndex) {
    const data = this.read();
    const contentHash = textHash(item.text);
    const existing = data.records.find(r => r.url === item.url);
    if (item.researchScope && existing && (existing.researchScope !== item.researchScope || existing.observedAt < item.observedAt - 86400000)) data.records = data.records.filter(r => r !== existing);
    if (data.records.some(r => r.url === item.url || r.contentHash === contentHash)) return false;
    data.records.push({ id: digest(item.url).slice(0, 24), platform: item.platform, url: item.url,
      author: item.username.toLowerCase(), topicIndex, topic: item.topic, content: item.text.slice(0, 1200), contentHash,
      recordType: item.source === 'comment' ? 'comment' : 'post', parentUrl: item.parentUrl || null,
      researchScope: item.researchScope || null, publishedAt: item.publishedAt ?? null,
      hook: item.text.split(/[\n.!?]/)[0].slice(0, 200), insightType: item.source === 'comment' ? 'audience_question' : 'high_engagement_hook',
      firstSeenAt: this.now(), observedAt: item.observedAt, metrics: item.metrics });
    data.records = data.records.slice(-500);
    save(this.file, data);
    return true;
  }
}
module.exports = { SwipeStore, DAY, digest, textHash };
