# Product Selling Automation

A local Node.js application for AI product marketing and image publishing on **X, Threads, Facebook and Instagram**. Product facts, source copy and writing examples ground generated captions. All four platforms are enabled in the current product configuration.

## Setup and operation

Requires Node.js 18+, npm, a Chromium browser with CDP enabled and a configured AI provider. Install with `npm install`. For a new installation, copy `product.example.json` to `product.json`; preserve existing settings and campaign history.

1. Enter product facts, sales URL and platform handles in `product.json`, or run `npm run content:wizard`. Add material to `product-copy.md` and examples to `knowledge/voice.md`.
2. Run `OPEN-BROWSER.bat`, sign in to all four platforms and keep that browser open.
3. Configure AI and browser settings in `.env`. Supported AI integrations are Antigravity CLI, MiniMax and OpenAI-compatible HTTP providers. Images use Antigravity or rendered PNG cards.
4. Run `npm run content:setup`, then `npm run content:preview` to inspect the next post offline.
5. Live publishing requires `POSTING_ENABLED=true`, `DRY_RUN=false` and `APPROVAL_MODE=false`. Run `npm start` for publishing with engagement or `npm run content:start` for publishing alone.

`start-automation.bat` validates settings, inspects recovery state, launches the browser, prepares a campaign when missing and starts automation. See [COMMANDS.md](COMMANDS.md).

## Four-platform support

Set `strategy.platforms` to `["x", "threads", "facebook", "instagram"]` and configure `seller.usernames` for each account. All publishers require prepared captions and images; enable `content_media.enabled`.

| Platform | Publishing behavior |
| --- | --- |
| X | Images with captions condensed to its 280-character handling; product links can use follow-up replies |
| Threads | Image posts with optional product-link replies |
| Facebook | Image posts; promotional captions can include the sales URL |
| Instagram | Image posts and captions; promotional captions refer to the bio link, which you configure manually |

Engagement supports Threads and Facebook public discussions and existing incoming Threads DM conversations. It does not initiate cold DMs. Optional initial research supports Threads and Facebook. Target-account style analysis supports X and Threads. These capabilities are separate from four-platform publishing.

## Content lifecycle

Setup checkpoints drafts in `private/product-generation.json` and creates `private/product-content.json` after preparation. Humanizer editing and validation hold failed drafts for review. Media is associated with the caption hash; changed captions require compatible images.

Interval scheduling measures cadence separately per platform from its last verified publication. Restarts resume the queue without a burst for missed intervals. Calendar scheduling supports local times and timezones. Saved product settings determine cadence and pilot quantities.

Promotions depend on the sales URL, value-post/view thresholds and promotion spacing. Thresholds support platform overrides; unknown views remain unknown. The initial learning pilot is value-only. Later content uses observed performance and validated public patterns. Rolling preparation produces replacements after verified publications, subject to campaign limits.

## Architecture and state

`threads-agent.js` routes to `src/content/content-cli.js`. The content layer handles setup, generation, writing checks, media, queue management, scheduling, metrics and learning. `src/ai/` manages AI requests and generated images. `src/browser/` connects Puppeteer to CDP. `src/platforms/` contains four platform adapters; `src/engagement/` handles product replies and `src/knowledge/` handles evidence and learned patterns.

State uses local JSON and Markdown rather than a database. Campaign writes use a shared lock and atomic replacement. Uncertain publication or message results require reconciliation before retrying. Inspect the platform first; never reset an uncertain post simply to retry it.

`OPEN-GUI.bat` opens a configuration editor at `http://127.0.0.1:3131`. Saves validate settings, acquire the campaign lock, back up prior contents and reject stale edits. Stop automation before GUI saves. Existing campaigns permit supported setting changes; facts, platform selection, source copy and voice require preserving/archiving the campaign and generation checkpoint before replacement. Older campaigns need `settings migrate` first. CLI settings changes can be queued while automation runs.

Browser adapters use platform DOM details and may need maintenance when websites change. Browser login credentials remain in your local browser session; API configuration stays in `.env`.

## Validation

- `npm test`: all current tests, including isolated headless-browser fixtures.
- `npm run test:content`: offline content, scheduling, configuration, engagement, media and learning tests.
- `npm run test:content:browser`: local browser fixtures. Set `CONTENT_TEST_BROWSER` if executable detection fails.

Tests use AI doubles and local DOM fixtures. They do not verify authenticated live platform operation or actual AI writing quality. Review generated drafts and account behavior before unattended operation.
