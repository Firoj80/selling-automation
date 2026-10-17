const SUPPORTED = ['threads', 'facebook', 'x', 'instagram'];
function disabledPlatforms(product) {
  const settings = product.publishing === undefined ? {} : product.publishing;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).some(key => key !== 'disabled_platforms')) throw new Error('publishing must contain only disabled_platforms');
  const disabled = settings.disabled_platforms === undefined ? [] : settings.disabled_platforms;
  if (!Array.isArray(disabled) || disabled.some(p => !SUPPORTED.includes(p)) || new Set(disabled).size !== disabled.length) throw new Error('publishing.disabled_platforms must contain unique supported platforms');
  return disabled;
}
function publishingEnabled(product, platform, state = null) { return product.strategy.platforms.includes(platform) && !disabledPlatforms(product).includes(platform) && !state?.recovery?.platformHolds?.[platform]; }
function activePlatforms(product, state = null) { return product.strategy.platforms.filter(platform => publishingEnabled(product, platform, state)); }
module.exports = { disabledPlatforms, publishingEnabled, activePlatforms };
