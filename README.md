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

Twenty-one locale homes are built: simplified and traditional Chinese, English, Japanese, Korean, Russian, Spanish, Portuguese, French, German, Italian, Arabic, Swedish, Dutch, Turkish, Polish, Croatian, Serbian, Ukrainian, Persian and Indonesian. Arabic and Persian render RTL. Football is the only active sport; basketball, volleyball and badminton are registered but do not generate routes until enabled.

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

Drafts are private review packets. Routine editing and post-match automation approve only the Chinese master for local preview. Derived languages are generated later, during the explicit production-release preparation step, so local copy changes do not spend translation/compliance work until publication is intended.

```bash
npm run review:pr
npm run review:admin
npm run review:html -- content/review-packets/<content>.json
npm run release:request -- content/review-packets/<content>.json --locales=zh
npm run publish:automatic -- --content=<id> --locales=zh
npm run build:zh
npm run release:prepare-locales
npm run content:publish -- content/review-packets/<content>.json
npm run release:aws -- --confirm-production
```

`npm run review:admin` starts a local review console on `http://127.0.0.1:3210`. It reads `content/review-packets` directly, renders the Chinese draft without requiring a public static page, shows automation/legal blockers, and splits the workflow into two explicit steps:

1. `生成审稿 HTML`
2. `提交中文发布申请`

The first step writes a private static review page to `private-review/html/<content-id>/index.html`, exposes a dynamic review page at `/review-preview/<content-id>` and a static review page at `/private-review/<content-id>/`, and keeps the draft suitable for editor and distribution review without generating a public page.

The second step runs `compliance:preaudit`, deterministic audit, and if the result is PASS, `publish:automatic --locales=zh` plus `build:zh`. If legal packs, jurisdictions or facts are incomplete, the console records `release_blocked` or `release_review_required` instead of failing with an untracked error. It never triggers AWS release.

`npm run review:smoke` exercises the same state machine end to end. It generates a private Chinese review HTML page, submits a release request, verifies that the workflow lands in `release_ready`, `release_review_required`, or `release_blocked`, and then resets the packet. The smoke run uses the local deterministic reviewer config in `pipeline/config/ai.smoke.json`; routine work continues to use `pipeline/config/ai.local.json`.

The AWS release repeats data, quality, test, editorial and prepublish gates, derives missing non-Chinese editions from the Chinese master, records rollback metadata, uploads new objects, publishes the CloudFront language router, removes retired objects and invalidates CloudFront. See `doc/AWS_Deployment_Guide.md`.

Search Console access stays local. Copy `pipeline/config/search-console.example.json` to the ignored `search-console.local.json`, set a short-lived `GOOGLE_SEARCH_CONSOLE_TOKEN`, then run:

```bash
npm run monitor:search -- --submit
npm run monitor:search
```

The report captures discovery, crawl, index state, Google-selected canonical, soft-404/coverage signals and a repair queue. Run it after 3, 7 and 14 days and weekly thereafter. Passing technical checks makes pages eligible for crawling and indexing; it does not guarantee inclusion in Google's index.
