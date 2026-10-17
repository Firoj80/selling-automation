const ORIGINS = { x: 'https://x.com', threads: 'https://www.threads.com', facebook: 'https://www.facebook.com', instagram: 'https://www.instagram.com' };
async function probeConnectivity(platforms, { fetchImpl = globalThis.fetch, timeout = 5000 } = {}) {
  const results = await Promise.all(platforms.map(async platform => {
    if (!ORIGINS[platform]) return { platform, reachable: false, reason: 'Unsupported platform' };
    try {
      // Any HTTP response establishes connectivity, including a login/403 response.
      await fetchImpl(ORIGINS[platform], { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeout) });
      return { platform, reachable: true };
    } catch (err) { return { platform, reachable: false, reason: err.message }; }
  }));
  return { online: results.every(result => result.reachable), platforms: results };
}
class RuntimeConnectivity {
  constructor({ platforms, check = probeConnectivity, now = () => Date.now(), interval = 15000 } = {}) { Object.assign(this, { platforms, check, now, interval }); }
  async poll({ force = false } = {}) {
    const platformKey = this.platforms.join('|');
    if (this.platformKey !== platformKey) { force = true; this.platformKey = platformKey; }
    if (!force && this.snapshot && this.now() < this.nextCheckAt) return { ...this.snapshot, resumed: false, changed: false };
    const before = this.snapshot?.online;
    const result = await this.check(this.platforms);
    this.nextCheckAt = this.now() + this.interval;
    this.snapshot = result;
    return { ...result, resumed: before === false && result.online, changed: before !== result.online };
  }
}
module.exports = { RuntimeConnectivity, probeConnectivity };
