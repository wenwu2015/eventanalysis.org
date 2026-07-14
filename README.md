# EventAnalysis.org

Event Analysis is a 21-language post-match football analysis publication. The first language matrix covers Chinese (simplified and traditional), English, Japanese, Korean, Russian, Spanish, Portuguese, French, German, Italian, Arabic, Swedish, Dutch, Turkish, Polish, Croatian, Serbian, Ukrainian, Persian and Indonesian. The public product is anonymous and static: no accounts, comments, submissions, database, public API, live scores, runtime content generation, or third-party match media.

## Public site

- `/` — language entry
- `/:locale/` — 21 independently translated edition homepages
- `/:locale/articles/:slug/` — reviewed analysis
- `/:locale/archive/` — published archive
- `/:locale/methodology/` — editorial method
- `/:locale/feed.xml`, `/sitemap.xml`, `/robots.txt` — generated static assets

Every route is emitted as a standalone `dist/client/**/index.html` file and loads only `/assets/site.css`. The public build has no Next.js, React, Vinext, Vite, Tailwind, hydration payload, runtime content API or framework script. All public match content is text, semantic HTML tables and CSS decoration. Do not add match screenshots, photography, GIFs, video, player portraits, crests, AI cartoons, remote embeds, or generated social images.

### Sport expansion boundary

Version one enables only `football`. `content/sports.json` is the single sport registry; basketball, volleyball and badminton are registered as `planned` and therefore produce no routes, navigation, feeds, sitemap entries or collection jobs. Every article and private fact bundle carries a `sport` code. Football keeps the short existing URL, while future sports already have isolated `/sports/:sport` base paths. Enabling another sport later requires its source adapter, deterministic rules and localized editorial vocabulary to pass review before changing its registry status to `active`.

## Local development

Node.js 22.13 or newer is required.

```bash
npm install
npm run dev
npm test
```

`npm run build` runs the local Node generator, recreates `dist/`, writes every HTML page plus RSS, Sitemap and Robots, and copies the single CSS asset. D1 and R2 stay disabled in `.openai/hosting.json`. `npm run start` is a tiny local file server used only for preview and tests; it is not deployed. Sites receives a seven-line static-asset pass-through Worker because its archive format requires an entrypoint; it has no rendering, API or application logic and is never loaded by the browser.

## Local collection pipeline

The collector is deliberately separate from the public site. It uses a real Playwright Chromium session, reads visible DOM, embedded page data and network responses naturally initiated by page navigation, and closes the browser context after every job.

1. Copy `pipeline/config/sources.example.json` to `pipeline/config/sources.local.json`.
2. Enter the contracted authorisation window, regions, concurrency, delay, storage-state path and permitted uses for each provider.
3. Copy `pipeline/config/ai.example.json` to `pipeline/config/ai.local.json` and configure local AI commands if desired.
4. Keep provider sessions under `private-auth/`; both files and all sessions are ignored by Git.
5. Run `npm run pipeline:daily` for the daily scan or `npm run pipeline:weekly` for the weekly gate.

The example source registry is inactive and unauthorised on purpose. A source runs only when `active` and `license.authorised` are both true, its date window is current, and its contract does not require public attribution. Access challenges, 401/403/429 responses and expired sessions stop the job; the collector does not bypass them.

If the installed Playwright package and an existing shared Chromium cache use different build numbers, set `browserExecutablePath` in the ignored local source entry. Never commit machine-specific browser paths.

SofaScore has a dedicated normaliser. Other authorised browser portals use a local `matchUrlTemplate` plus an `eventMapping` of normalized fields to dotted JSON paths. This keeps portal-specific selectors and contracted URLs in the ignored local registry while allowing independent score confirmation without direct API calls.

### AI command contract

Commands are arrays, never shell strings. The configured writer receives:

- `EA_PROMPT_PATH` — private JSON prompt and deterministic facts
- `EA_OUTPUT_PATH` — destination for the multilingual Article JSON

Video commands receive `EA_AUDIO_PATH` or `EA_FRAMES_PATH` plus `EA_OUTPUT_PATH`. Without configured AI commands, the pipeline creates a blocked review packet rather than inventing output.

### Temporary media policy

Each match uses a unique directory under `pipeline/jobs/`. Success, failure, cancellation and disk-limit exits all pass through the same `finally` cleanup. Video, audio, frames, HTML, JSON bodies, transcripts, model outputs and task logs are deleted. Only the article/review object and a plain URL list under ignored `private-sources/` may survive.

Startup removes orphan job directories older than one hour. The default per-job disk limit is 2 GiB. Deletion is ordinary filesystem deletion, not secure erase.

## Editorial and publication gate

Deterministic code owns scores, head-to-head rates and line-up continuity. AI may explain the supplied facts but cannot publish. Fewer than two independent confirmations, unresolved data conflicts, missing personnel evidence, expired rights, or attribution conflicts produce `data_incomplete` and block publication.

Draft statuses are `draft`, `needs_review`, `data_incomplete`, `approved` and `published`.

```bash
npm run review:pr
npm run content:publish -- content/review-packets/<article>.json
npm test
```

`review:pr` opens a draft GitHub PR. A human verifies facts, wording, rights and numeric consistency across all required language editions, then changes the article to `approved`. A translation that is missing or still pending never falls back to English on the public route. The promotion command alone can turn an approved review file into a published manifest entry. Merging that reviewed change triggers the static-site release workflow.

## Advertising

`site/ad-config.json` is the only ad switch and starts with `enabled: false`. Disabled ads render no DOM and load no JavaScript. Enabled creatives are structured HTTPS-only entries; arbitrary HTML and scripts are rejected. When enabled, the framework-free `site/ad-slot.js` component is the only executable browser script.

Every active slot displays `AD`, exposes the full `Advertisement` tooltip, closes independently for the browser session, and uses:

```html
<a target="_blank" rel="nofollow noopener noreferrer">
```

## Verification

The test suite covers deterministic calculations, multilingual content policy, rights and evidence exclusions, successful/failed/cancelled/disk-limit cleanup, orphan cleanup, static assets, anonymous routes, disabled ad output, media prohibition, provider disclosure prohibition, structured metadata and the deployable Sites bundle. It also recursively scans every generated HTML file and fails if a framework name, framework asset, executable script source, ad placeholder or media element appears while ads are disabled.
