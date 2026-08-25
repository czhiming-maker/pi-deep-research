# Provider Plugin Foundation — Design Spec

- **Date:** 2026-08-25
- **Status:** Approved (pending implementation plan)
- **Supersedes:** Direction of PR #4 (local-first search), which will be closed with thanks
- **Repo:** czhiming-maker/pi-deep-research

## Motivation

The review of PR #4 (Firecrawl + SearXNG local-first search) found solid provider-chain code but four structural problems:

1. **Providers are hardcoded** — every new provider (Firecrawl, SearXNG, future ones) becomes core code we must maintain and ship.
2. **The air-gap guarantee is encoded as asymmetric chain semantics** ("local empty → only local; local error → cloud"), which is subtle, hard to reason about, and hard to test.
3. **The promised docs never existed** (commit messages referenced `SETUP_LOCAL.md` that was never `git add`-ed).
4. **Single-file growth** — `extension.ts` grew 500 → 746 lines with all logic interleaved.

Maintainer decision: reimplement on `main` as a **plugin foundation**. The package becomes a chain engine + plugin contract; native support is limited to Tavily and Brave (current behavior); anything else is a user-implemented drop-in plugin. PR #4's Firecrawl/SearXNG knowledge is preserved as example plugins.

## Goals

1. **Zero-config compatibility:** with only `TAVILY_API_KEY` / `BRAVE_API_KEY` set, behavior is identical to v0.1.6 (same defaults, same tool schemas, same successful-path output).
2. **Hot-pluggable providers:** a user drops one TypeScript file into a convention directory; `/reload` activates it. No pi extension API knowledge required.
3. **Explicit, uniform, observable chain semantics** — see Chain Semantics.
4. **Air-gap by configuration:** listing only local providers means cloud is never in the chain. No hidden cloud reach under any runtime condition.
5. **Testable core:** the chain engine is a pure function over an injectable provider list and injectable `fetch`; the full empty/error/ordering matrix is unit-testable offline.
6. **Small core:** the chain engine has zero knowledge of specific providers.

## Non-Goals (v1)

- No project-level plugin directory (would bypass pi's project trust gate — see Security).
- No event-bus registration channel (`pi.events`).
- No plugin distribution via npm packages (drop-in files only).
- No Firecrawl/SearXNG in core code (examples only).
- No per-provider timeout configuration, no SearXNG language parameterization, no provider health checks, no result backfill after domain filtering.

## Architecture Overview

```
extension.ts (thin entry: registers web_search / web_extract / web_batch_search)
  └── src/
        config.ts        env parsing + SEARCH_PROVIDERS validation
        chain.ts         pure chain engine (search / extract / batch)
        loader.ts        plugin directory scan + jiti dynamic loading
        native/          built-in providers, same interface as plugins
          tavily.ts
          brave.ts
        shared.ts        domain filter, structure-preserving truncation, metadata
examples/providers/       example plugins (firecrawl.ts, searxng.ts) — NOT shipped as core
test/                     node:test suites
```

The chain engine operates on a **registry** of `SearchProvider` objects. The registry = native providers + loaded plugins. The chain cannot tell them apart (native names are reserved so plugins cannot shadow them).

## Provider Contract (v1 public API)

```ts
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
  publishedDate?: string;
}

export interface ExtractResult {
  title: string;
  url: string;
  content: string;
  author?: string;
  publishedDate?: string;
  wordCount: number;
  provider: string;          // name of the provider that produced this
}

export interface SearchRequest {
  query: string;
  maxResults: number;
  searchDepth?: "basic" | "advanced";   // optional hint; providers may ignore
  signal?: AbortSignal;                 // chain-enforced timeout
}

export interface SearchProvider {
  name: string;                 // unique, lowercase [a-z0-9-]
  tier: "local" | "cloud";      // metadata for output/observability only — never drives logic
  isConfigured(): boolean;      // false → skipped, recorded in attempts
  search(req: SearchRequest): Promise<SearchResult[]>;   // throw = failure; empty array = success
  extract?(url: string): Promise<ExtractResult>;         // optional capability
}
```

A plugin is a single `.ts` file whose **default export** conforms to `SearchProvider`. `tier` is display metadata only — no asymmetric behavior by tier (this is the key simplification over PR #4).

## Discovery & Loading

- **Plugin directory (v1, global only):** `~/.pi/agent/pi-deep-research/providers/*.ts`
  - A missing directory is normal (no plugins) — scan silently yields an empty registry; the loader never creates or errors on it.
- **Loader:** the extension creates its own jiti instance (`createJiti(import.meta.url)` from the `jiti` dependency, ^2) and calls `jiti.import()` on each discovered file. We do NOT rely on pi's internal jiti handling dynamic imports — that behavior is undocumented and outside our control. Verified by spike (2026-08-25): jiti 2 dynamic-imports a TS plugin file exporting a typed provider object correctly.
- **Lifecycle:** scan + load + validate runs on `session_start`. pi's `/reload` re-runs the extension lifecycle (`session_shutdown` → `session_start`), which rebuilds the registry from scratch — this is the hot-plug mechanism. No mid-session file watching.
- **Per-file validation (runtime shape check):** default export must be an object with a valid `name` and a `search` function. Invalid file → skip with `console.warn` naming the file and the reason; extension startup continues.
- **Name collisions:** native names (`tavily`, `brave`) are reserved — a plugin using them is rejected with a warning. Two plugins with the same name → both loaded, second rejected with a warning naming both files.
- **Load errors:** a plugin file that throws on import is skipped with a warning; startup continues.

## Configuration

- **`SEARCH_PROVIDERS`** — comma-separated, ordered provider list, e.g. `SEARCH_PROVIDERS=firecrawl,searxng,tavily,brave`.
  - Default when unset: `tavily,brave` (zero-config = v0.1.6 behavior).
  - Normalization: entries are trimmed and lowercased; empty entries dropped; duplicates keep the first occurrence.
  - The list defines both **set** and **order**. Air-gap users list only local providers; cloud never enters the chain — this replaces PR #4's asymmetric rules and the proposed `LOCAL_ONLY` switch with one mechanism.
- **Persistent config file** (added 2026-08-25, pre-release): `~/.pi/agent/pi-deep-research/config.json` with `{"providers": ["name", ...]}` — set the chain once instead of exporting an env var every session. Resolution order: `SEARCH_PROVIDERS` env var (explicit, session-scoped) → config file → default `tavily,brave`. A missing file or missing/empty `providers` key means "use the default". A malformed file (bad JSON, wrong types) is a **hard startup error** — never a silent fallback to the cloud defaults, which would break the air-gap guarantee for anyone whose only local-provider config is this file.
- **Provider-specific env** unchanged: `TAVILY_API_KEY`, `BRAVE_API_KEY`; plugins read their own env (e.g. `FIRECRAWL_BASE_URL` in the example).
- **Validation (fail fast, at session_start after plugin loading):**
  - A `SEARCH_PROVIDERS` entry that is not in the registry → startup error listing the unknown name and all available names.
  - Registry is complete at this point (plugins load before validation), so no lazy re-validation is needed.
- **Nothing configured at all** (no keys, no plugins, default list): `web_search` fails with an error equivalent to today's "No search API configured. Set TAVILY_API_KEY or BRAVE_API_KEY…" plus a pointer to `SEARCH_PROVIDERS` docs. (Note: the base file's header comment claims a "bash curl fallback" that does not exist in code; the rewritten header drops this claim.)

## Chain Semantics (uniform)

For each provider in `SEARCH_PROVIDERS` order:

1. `isConfigured() === false` → record attempt `{provider, status: "skipped", reason: "not configured"}`, continue.
2. `search()` returns ≥ 1 result → **win**: return results (after domain filtering) with the attempts log.
3. `search()` returns empty array → record `{provider, status: "empty"}`, continue to next provider.
4. `search()` throws → record `{provider, status: "error", message}`, continue to next provider.
5. All providers exhausted with no non-empty result → throw an aggregated error listing every attempt. This replaces the base's misleading "No search API configured" when a key IS set but the API errored.

**Per-call timeout:** the chain wraps every `search()`/`extract()` call with `AbortSignal.timeout(30_000)` via `req.signal`. Providers should honor it; a provider that hangs fails over instead of blocking the chain. (Deliberate delta from base, which had no timeouts for Tavily/Brave.)

**Observability:** the attempts log is attached to every result and failure. Tool output rules:
- **Successful search:** output unchanged from v0.1.6 (no extra lines) — preserves byte-level compatibility on the happy path.
- **Zero results or error:** output appends an attempts summary, e.g. `Attempts: tavily → error (401 Unauthorized), brave → empty`. "Why did I get 0 results" is always answerable.

**Extract chain:** walk `SEARCH_PROVIDERS` in order; the first configured provider that has `extract()` handles the URL; if none, fall back to the basic HTTP fetch (current regex-based extraction). Output reports the provider that actually ran (`**Provider:** X` line — deliberate delta from base, inherited from PR #4). Empty/blank markdown from a provider's `extract()` counts as failure → continue down the chain (inherited from PR #4's fix for hollow "successful" extracts).

**Batch search:** runs the search chain per query in parallel; failures are surfaced per query (inherited from PR #4's fix — base silently returned empty arrays). Output lists the providers actually used across the batch.

**Domain filtering:** `include_domains` / `exclude_domains` are applied client-side, uniformly across all providers (single + batch), with subdomain-aware matching (`example.com` matches `www.example.com`, not `notexample.com`). Applied after the provider returns, before truncating to `maxResults`. No backfill from beyond `maxResults` (documented limitation; providers already return ranked results).

## Native Providers

`tavily.ts` and `brave.ts` port the existing implementations behind the `SearchProvider` interface (same API endpoints, params, response mapping). Tool schemas and descriptions for `web_search` / `web_extract` / `web_batch_search` are unchanged except: mention of provider configuration moves from "Tavily/Brave" phrasing to "configured providers (default: Tavily, Brave)" where the LLM-facing semantics do not change.

## Packaging

- `package.json`:
  - `dependencies`: `jiti` (^2) — the only new dependency, and it must be a **runtime** dependency because pi installs packages with `--omit=dev`.
  - `files`: add `src/` and `examples/`.
  - `scripts.test`: `node --test test/` (dev-only; requires Node ≥ 22.6 for native TS type stripping — runtime is unaffected, pi still loads via jiti).
  - `version`: 0.3.0 (minor: new capability, no breaking changes). CHANGELOG entry included.
- No changes to `pi` field (entry stays `./extension.ts`).

## Example Plugins (`examples/providers/`)

Ported from PR #4 (credit: @fank), documented as copy-paste starting points, NOT shipped as active code:

- `firecrawl.ts` — `/v1/search` + `/v1/scrape` (Playwright-rendered → Markdown), `FIRECRAWL_BASE_URL`, optional `FIRECRAWL_BASIC_AUTH` (Authorization header only; never in errors/logs). 30s timeout, `success: false` treated as failure.
- `searxng.ts` — JSON API via `SEARXNG_BASE_URL`. Header comment documents the critical gotcha from PR #4: **SearXNG's JSON API is disabled by default (403); `settings.yml` must enable `search.formats: [html, json]`**.
- `examples/README.md` — install instructions: copy to `~/.pi/agent/pi-deep-research/providers/`, set env, list in `SEARCH_PROVIDERS`, `/reload`.

## Security

- **Global dir only in v1.** Loading `<project>/.pi/deep-research/providers/` would execute project-controlled TypeScript without pi's project trust gate. Deferred until pi exposes a trust-state API (see Future Work).
- Plugin code runs with full user privileges — same trust level as `~/.pi/agent/extensions/`. Documented in README.
- Secrets (API keys, basic-auth) never appear in error messages or logs.
- SSRF surface is unchanged from base (`web_extract` fetches LLM-supplied URLs; a plugin like Firecrawl can amplify reach — noted in the plugin authoring docs).

## Backward Compatibility (exact deltas vs v0.1.6)

Unchanged with only Tavily/Brave keys set: default provider list, tool schemas, successful search output, extract output format (modulo the new `**Provider:**` line), no-key error message (plus one pointer line).

Deliberate deltas (all improvements, called out in CHANGELOG):

1. Empty-result fall-through: base returned Tavily's empty result immediately; now an empty Tavily result also tries Brave. (More resilient; may consume Brave quota on empty-result queries.)
2. Aggregated failure error replaces the misleading "No search API configured" when a key is set but the API errors.
3. Hung provider calls time out (30s) and fail over instead of hanging.
4. `web_extract` output gains a `**Provider:**` line (from PR #4).
5. Batch search surfaces per-query failures instead of silent empty arrays (from PR #4).
6. Structure-preserving truncation replaces whitespace-flattening truncation (from PR #4).

## Testing Strategy

`node:test`, zero new dev dependencies, fully offline (inject `fetch` and provider lists):

- `test/chain.test.ts` — the matrix: per-provider outcomes (ok / empty / error / skipped) × ordering × first-non-empty-wins × aggregated error content × timeout enforcement.
- `test/config.test.ts` — `SEARCH_PROVIDERS` parsing (whitespace, case, dupes), defaults, unknown-name validation error.
- `test/loader.test.ts` — temp dir with fixture plugins: valid, invalid shape, import-throwing, native-name collision, plugin-plugin collision.
- `test/shared.test.ts` — domain filter subdomain semantics; structure-preserving truncation.
- `test/native.test.ts` — Tavily/Brave response mapping against mock fetch payloads.

## PR #4 Closure

After this lands on `main`: close PR #4 with a thank-you comment explaining the direction change (plugin foundation), linking the new docs and the example plugins derived from the PR's work.

## Future Work

- Project-level plugin directory (blocked on pi trust-state API).
- `pi.events` registration channel as an alternative plugin mechanism.
- Per-provider timeout configuration.
- Plugin distribution as npm packages.
- Result backfill after domain filtering.

## Success Criteria

1. `npm test` passes fully offline.
2. `npm pack --dry-run` output includes `src/`, `examples/`, updated `files`.
3. Manual smoke with only `TAVILY_API_KEY`: `web_search` behaves and formats output identically to v0.1.6 on the happy path.
4. Manual smoke: drop example plugin into the directory, set `SEARCH_PROVIDERS`, `/reload`, verify the plugin serves search; remove it from the list → plugin present but unused; mistype a name → startup error lists available providers.
