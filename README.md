# EventAnalysis.org

Event Analysis is a framework-free, static football publication. Public pages contain editorial text, semantic HTML tables and CSS only; there are no accounts, comments, public APIs, databases, third-party media or runtime rendering.

## Public information architecture

All indexable pages use one URL builder and one contract:

```text
/{locale}/{sport}/{localized-section}/{localized-slug}/
```

Examples:

```text
/en/football/
/en/football/match-analysis/spain-england-euro-2024-final/
/zh/football/比赛分析/西班牙-英格兰-2024欧洲杯决赛/
```

The root request redirects from `Accept-Language` to `/{locale}/football/`; unsupported languages use English. A language menu is present on every page. Missing editions link to that language's football homepage and never display English replacement text.

Twenty-one locale homes are built: simplified and traditional Chinese, English, Japanese, Korean, Russian, Spanish, Portuguese, French, German, Italian, Arabic, Swedish, Dutch, Turkish, Polish, Croatian, Serbian, Ukrainian, Persian and Indonesian. Arabic and Persian render RTL. The current public build baseline is still football-first; basketball, volleyball and badminton are registered and reserved for independent channels when the broader multi-sport rollout is enabled.

## Confirmed product requirements

The repository baseline and the long-term product target are intentionally documented separately. The rules below describe the confirmed operating direction for future automation and publication work, even where the current build still exposes a narrower football-first surface.

### Channel and locale rules

- Each sport is an independent publication channel with its own homepage, taxonomy, feeds, sitemaps and review queue.
- The first-wave sports are `football`, `basketball`, `volleyball` and `badminton`.
- Chinese is the only editable master edition. All non-Chinese editions are derived translations and must stay traceable to the current Chinese source revision.
- The first-wave multilingual publication target for automated editorial and trend workflows is `zh`, `zh-hant`, `en`, `ja`, `es` and `ar`.
- Every article and static HTML page must expose publication time, content category, associated person or major event when that field exists deterministically.

### Editorial and factual rules

- The editor-facing workflow is now autopilot-first: new packets enter the editorial agent chain automatically, and the visible recovery action is `重新触发自动审稿`.
- Lawyer review, legal-pack completion and jurisdiction-material review are removed from the editorial workflow. They are not blocking requirements for routine article approval.
- Core match facts may publish when either two independent authorised sources confirm them, or one authorised official source confirms them and the source registry marks it as official.
- Single-source publication is never permission to invent supporting facts. If extra facts cannot be confirmed deterministically, the article must stay narrow and describe only what the authorised source actually supports.
- No fabricated data, no synthetic statistics, no subjective judgement, no personal attacks and no invented background colour.
- For post-match articles, result, head-to-head win rate and lineup continuity remain deterministic program outputs rather than free-form writing claims.

### Trends and roundup rules

- The trends workflow uses Google Trends active data for the previous 24 hours from `https://trends.google.com/trending?geo=US&hl=zh-CN&hours=24&status=active`.
- It runs at least twice per day, morning and evening local scheduler time, and writes durable checkpoints before and after each major step.
- Trend-derived articles must be grounded in visible page data, page-embedded data or normal page-load responses only. Do not depend on undocumented APIs, challenge bypasses or invented enrichment.
- If a trend cannot be deterministically assigned to one of the active sports channels, skip it rather than forcing it into a category.
- The system may generate both per-trend factual pages and morning/evening roundup pages, but only from confirmed real-time inputs.
- If no independently confirmed supporting context is available beyond the trend signal itself, publish only a narrowly described factual trend note or skip the item.

### Workflow, state and recovery rules

- Every draft and edition must keep durable workflow state on disk so work can resume after network loss, computer restart, editor switch, session switch or interrupted automation.
- The minimum cross-session lifecycle states are `draft`, `edited_pending_publish`, `published` and `deleted`.
- Review, translation, release preparation and publish jobs must checkpoint progress, inputs, outputs, timestamps and failure reasons in durable local files rather than ephemeral process memory.
- Automation must resume from the last durable checkpoint and must not require the originating Codex session, browser tab or editor process to still exist.
- The system should separate draft generation, review approval, translation generation, local static preview, release preparation and public release so each phase can be retried independently.

### Publication and SEO rules

- The Chinese master is the publication source of truth. Other locales are produced by deterministic translation and release preparation from that master.
- All published pages must complete the standard SEO contract before release: canonical URL, hreflang, structured data, sitemap coverage, feed inclusion, internal linking, valid metadata and crawl-safe static HTML.
- Each article must land in the correct sport channel and category so later automation can generate channel indexes, archives, roundups and related-content links without manual sorting.
- Public release automation must preserve status traceability: an operator must be able to tell whether an item is unpublished, edited and waiting to republish, already published or deliberately deleted.

## Structured content boundaries

```text
content/data/       versioned entities, events, facts, claims, content items and editions
private-evidence/   ignored source URLs, rights snapshots, hashes and field-level evidence
pipeline/runtime/   disposable SQLite index, similarity reports and release reports
dist/client/        deployable static website
```

JSON is the source of truth. SQLite is a disposable local query index and can be deleted and rebuilt. Stable internal IDs are public-data references; provider identifiers remain in ignored private mappings.

```bash
npm run data:validate -- --require-private-evidence
npm run data:index
npm run data:audit -- --content content_euro_2024_final_analysis
npm run content:revision -- --content content_euro_2024_final_analysis --revision 1 --freeze
npm run content:revision -- --content content_euro_2024_final_analysis --revision 1 --build
```

Every published paragraph references a Claim, every Claim references deterministic Facts, and every Fact references private Evidence. Personnel and team relations include validity intervals.

Before changing a ContentItem, freeze its current numbered revision. Snapshots are immutable JSON plus SHA-256 and can rebuild into an isolated `dist/revisions/` directory. Git remains the change history; the revision snapshot makes regeneration independent of the current item file.

## Collection and resource lifecycle

Each collection task has its own Playwright context and temporary directory. A source is checked before navigation for authorisation window, region, public-attribution conflict and retention conflict. Access challenges, 401/403/429 responses and expired sessions stop the task; no challenge or access control is bypassed.

In `finally`, the job removes pages, response bodies, video, audio, subtitles, frames, transcripts and temporary outputs, clears the browser context and releases storage. Only a sanitised URL list and compact private Evidence record survive. Startup removes orphan directories older than one hour and the per-job disk cap aborts and cleans the task.

## Editorial and duplication gate

The versioned policy is `pipeline/config/quality-policy.json`. Publication checks execute in this order:

1. duplicate search intent and angle;
2. 12-token contiguous source overlap;
3. exact title, deck, paragraph and body hashes;
4. five-token shingles and Jaccard similarity;
5. local multilingual vector similarity;
6. Claim and Fact overlap;
7. language/script and edition completeness;
8. rendered-page value, links and technical SEO.

BLOCK results cannot be overridden. REVIEW results need a second reviewer different from the author. A second article about one event needs at least three new analysis Claims.

```bash
npm run quality:calibrate
npm run quality:index
npm run quality:audit -- --content content_euro_2024_final_analysis
npm run quality:release
```

The public editorial gate also blocks production-process attribution, placeholders and stock filler. It is an editorial specificity check, not a promise to defeat third-party authorship classifiers.

## Static build and search

```bash
npm install
npm run build:zh
npm run build:preview
npm run build:preview:all
npm run build
npm test
npm run verify:editorial
npm run verify:prepublish
```

The generator registry supports match analysis, moments, people, comparisons, teams, competitions, places, topics and roundups. It creates only non-empty collection pages. Published locale editions are independent.

Each supported language with published content receives a static search index and a first-party JavaScript filter. Results are also present in HTML, so links and content remain usable without JavaScript. Search pages are `noindex,follow`. The build emits self-canonical URLs, reciprocal hreflang, breadcrumbs, Article/SportsEvent JSON-LD, RSS, locale/sport/type sitemaps, a sitemap index, Robots and a real 404.

Advertising is disabled in `site/ad-config.json`; disabled builds emit no advertising DOM, space, script or request. When enabled, the shared component uses structured HTTPS creatives, `AD`/`Advertisement`, a session-only close action and `<a target="_blank" rel="nofollow noopener noreferrer">`.

## Review and publication

Drafts are private review packets. New packets go straight into the editorial autopilot chain: editor review, up to three Chinese rewrites, full-locale translation, production publish and live verification. Legacy PR and one-click local-preview tools remain in the repo for manual fallback only; they are no longer the official entry point.

```bash
npm run review:admin
npm run review:html -- content/review-packets/<content>.json
npm run editorial:autopilot -- --content=<id>
npm run editorial:autopilot -- --resume-pending
npm run publish:agent -- --content=<id>
npm run build:zh
npm run release:prepare-locales
npm run release:aws -- --confirm-production
```

`npm run review:admin` starts a local monitoring console on `http://127.0.0.1:3210`. It reads `content/review-packets` directly, renders the Chinese draft without requiring a public static page, and centers the editor-facing workflow on autopilot state, logs, retry count, quarantine, and `重新触发自动审稿`.

`npm run editorial:autopilot -- --content=<id>` is the single automatic editorial entry point. It consumes the current review packet, structured facts and claims, workflow state, deterministic findings and preaudit output, then runs the `editor` agent. If the decision is `rewrite`, the `rewriter` agent may update only `editions.zh`, and the loop can run at most three times. If the decision is `approve`, the system records the override decision, stages the Chinese master, derives all non-`zh` locales, runs `npm run release:aws -- --confirm-production`, and verifies the live result. Content-class deterministic `BLOCK` or `REVIEW` findings stay as audit inputs and do not veto publication by themselves.

Only execution failures remain hard stops: invalid schema, missing commands or config, agent timeout, translation failure, AWS credential or upload failure, and live verification failure. AWS-side failures also trigger `npm run emergency:freeze -- --reason=autopilot_release_failure`.

`npm run review:smoke` now exercises the same autopilot chain end to end. It triggers `editorial:autopilot`, waits for `published`, `autopilot_failed`, or `quarantined`, then resets the packet. The smoke run uses `pipeline/config/ai.smoke.json`; routine work continues to use `pipeline/config/ai.local.json`.

The AWS release repeats data, quality, test, editorial and prepublish gates, derives missing non-Chinese editions from the Chinese master, records rollback metadata, uploads new objects, publishes the CloudFront language router, removes retired objects and invalidates CloudFront. In the official flow, this step is invoked by `publish:agent`, not by PR review. See `doc/AWS_Deployment_Guide.md`.

Search Console access stays local. Copy `pipeline/config/search-console.example.json` to the ignored `search-console.local.json`, set a short-lived `GOOGLE_SEARCH_CONSOLE_TOKEN`, then run:

```bash
npm run monitor:search -- --submit
npm run monitor:search
```

The report captures discovery, crawl, index state, Google-selected canonical, soft-404/coverage signals and a repair queue. Run it after 3, 7 and 14 days and weekly thereafter. Passing technical checks makes pages eligible for crawling and indexing; it does not guarantee inclusion in Google's index.
