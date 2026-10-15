const { canonicalPostUrl } = require('./post-metrics');
const METRICS = ['views', 'likes', 'comments', 'shares'];
const { sellingSettings } = require('./campaign-settings');
class ContentTracker {
  constructor({ product, state, persist = () => {}, reader, now = () => Date.now(), refreshIntervalMs = 15 * 60000 }) {
    Object.assign(this, { product, state, persist, reader, now, refreshIntervalMs });
  }
  publishedPosts() {
    const urls = new Set();
    return this.state.posts.filter(post => {
      if (post.status !== 'published' || !post.result?.verified || post.result.simulated) return false;
      const url = canonicalPostUrl(post.result.postUrl, post.platform);
      if (!url) return false;
      if (url && urls.has(url)) return false;
      if (url) urls.add(url);
      return true;
    }).sort((a, b) => (a.publishedAt || 0) - (b.publishedAt || 0));
  }
  getTotalViews() {
    return this.publishedPosts().reduce((total, post) => total + (this.hasVerifiedMetrics(post) && Number.isSafeInteger(post.metrics.views) && post.metrics.views >= 0 ? post.metrics.views : 0), 0);
  }
  /**
   * Returns cumulative views for posts on a specific platform.
   */
  getViewsForPlatform(platform) {
    return this.publishedPosts()
      .filter(p => p.platform === platform)
      .reduce((total, post) => total + (this.hasVerifiedMetrics(post) && Number.isSafeInteger(post.metrics.views) && post.metrics.views >= 0 ? post.metrics.views : 0), 0);
  }
  /**
   * Gets the view threshold for a specific platform.
   * Uses per-platform override if set, otherwise falls back to the global threshold.
   */
  getThresholdForPlatform(platform) {
    return sellingSettings(this.product, platform).minimum_views;
  }
  hasVerifiedMetrics(post) {
    const url = canonicalPostUrl(post.result?.postUrl, post.platform);
    return url && post.metrics?.source === 'browser' && post.metrics.postUrl === url;
  }
  /**
   * Returns true if selling is unlocked for a specific platform.
   * Requires: sales_url set + adaptive phase + enough value posts on that platform + views hit threshold.
   */
  shouldStartSellingOnPlatform(platform) {
    if (!this.product.product.sales_url) return false;
    if (!this.pilotReady(platform)) return false;
    const platformValuePosts = this.publishedPosts().filter(p => p.platform === platform && p.type === 'value').length;
    const platformViews = this.getViewsForPlatform(platform);
    const threshold = this.getThresholdForPlatform(platform);
    return platformValuePosts >= sellingSettings(this.product, platform).minimum_value_posts &&
      platformViews >= threshold;
  }
  /**
   * Returns true if at least one configured platform has unlocked selling.
   */
  shouldStartSelling() {
    if (!this.product.product.sales_url) return false;
    return this.product.strategy.platforms.some(p => this.shouldStartSellingOnPlatform(p));
  }
  pilotReady(platform) {
    if (this.product.strategy?.bypass_pilot || this.product.selling?.bypass_pilot || (sellingSettings(this.product, platform).minimum_value_posts === 0 && sellingSettings(this.product, platform).minimum_views === 0)) {
      return true;
    }
    const pilotTarget = this.product.pilot?.posts_per_platform?.[platform] || 0;
    const published = this.publishedPosts().filter(p => p.platform === platform);
    if (published.length < pilotTarget) return false;
    const minMature = this.product.learning?.minimum_mature_posts_per_platform ?? 0;
    const mature = published.filter(p => Array.isArray(p.observations) && p.observations.length > 0).length;
    return mature >= minMature;
  }
  getProductMentionRatio(platform = this.product.strategy.platforms[0]) {
    const interval = sellingSettings(this.product, platform).one_product_post_every;
    const recent = this.publishedPosts().filter(p => p.platform === platform).slice(-interval);
    return { productPosts: recent.filter(p => p.type === 'product').length, totalPosts: recent.length, interval };
  }
  shouldPublishProduct() {
    return this.product.strategy.platforms.some(platform => this.shouldPublishProductForPlatform(platform));
  }
  /**
   * Returns true if a product post should be published specifically on this platform.
   * Checks per-platform view threshold and per-platform product post cooldown.
   */
  shouldPublishProductForPlatform(platform) {
    if (!this.shouldStartSellingOnPlatform(platform)) return false;
    const { interval } = this.getProductMentionRatio(platform);
    const recentOnPlatform = this.publishedPosts()
      .filter(p => p.platform === platform)
      .slice(-(interval - 1));
    return !recentOnPlatform.some(p => p.type === 'product');
  }
  /**
   * Returns a per-platform selling status object — useful for content:status display.
   */
  getSellingStatus() {
    const status = {};
    for (const platform of this.product.strategy.platforms) {
      const views = this.getViewsForPlatform(platform);
      const threshold = this.getThresholdForPlatform(platform);
      const eligible = this.shouldStartSellingOnPlatform(platform);
      status[platform] = {
        criteria: sellingSettings(this.product, platform),
        pilotReady: this.pilotReady(platform),
        publishedValuePosts: this.publishedPosts().filter(p => p.platform === platform && p.type === 'value').length,
        hasSalesUrl: !!this.product.product.sales_url,
        ratio: this.getProductMentionRatio(platform),
        views,
        threshold,
        needed: Math.max(0, threshold - views),
        eligible,
        selling: this.shouldPublishProductForPlatform(platform)
      };
    }
    return status;
  }
  summary() {
    const posts = this.publishedPosts();
    const sellingStatus = this.getSellingStatus();
    return {
      totalViews: this.getTotalViews(),
      publishedPosts: posts.length,
      valuePosts: posts.filter(p => p.type === 'value').length,
      postsWithKnownViews: posts.filter(p => this.hasVerifiedMetrics(p) && Number.isSafeInteger(p.metrics.views)).length,
      sellingEligible: this.shouldStartSelling(),
      nextProductEligible: this.shouldPublishProduct(),
      ratio: this.getProductMentionRatio(),
      sellingStatus
    };
  }
  async getPostMetrics(post) {
    if (!this.reader) throw new Error('Browser metrics reader is not configured');
    return this.reader.read(post);
  }
  async refresh({ force = false } = {}) {
    for (const post of this.publishedPosts()) {
      if (!force && Number.isFinite(post.metricsCheckedAt) && this.now() - post.metricsCheckedAt < this.refreshIntervalMs) continue;
      post.metricsCheckedAt = this.now();
      try {
        const data = await this.getPostMetrics(post);
        const url = canonicalPostUrl(post.result?.postUrl, post.platform);
        if (!url || data.source !== 'browser' || canonicalPostUrl(data.postUrl, post.platform) !== url) throw new Error('Metric source does not match the published post');
        const observedAt = this.now();
        const previous = this.hasVerifiedMetrics(post) ? post.metrics : {};
        const metrics = { source: 'browser', postUrl: url, observedAt: previous.observedAt ?? null, observedAtByMetric: { ...previous.observedAtByMetric } };
        const observation = { source: 'browser', postUrl: url, observedAt };
        for (const key of METRICS) {
          if (data[key] !== null && data[key] !== undefined && (!Number.isSafeInteger(data[key]) || data[key] < 0)) throw new Error(`Invalid ${key} count`);
          metrics[key] = data[key] ?? (this.hasVerifiedMetrics(post) ? post.metrics[key] : null) ?? null;
          observation[key] = data[key] ?? null;
          if (data[key] != null) { metrics.observedAtByMetric[key] = observedAt; metrics.observedAt = observedAt; }
        }
        post.metrics = metrics;
        const settings = this.state.learning?.settings;
        const ageHours = (observedAt - post.publishedAt) / 3600000;
        const inWindow = !settings || (ageHours >= settings.observation_age_hours && ageHours <= settings.observation_age_hours + settings.observation_window_hours);
        if (inWindow && METRICS.some(key => observation[key] !== null)) {
          post.observations ||= [];
          if (!post.observations.some(item => item.observedAt === observedAt && item.postUrl === url)) post.observations.push(observation);
        }
        post.metricsError = METRICS.every(key => data[key] == null) ? 'No readable engagement labels; retaining last observed counts' : null;
      } catch (err) { post.metricsError = err.message; }
      this.persist(this.state);
    }
    return this.summary();
  }
}
module.exports = { ContentTracker };
