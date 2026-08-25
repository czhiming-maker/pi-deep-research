# Provider Plugin Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild web search on a hot-pluggable provider-chain foundation — native support limited to Tavily and Brave, anything else is a user drop-in plugin, zero-config behavior identical to v0.1.6.

**Architecture:** `extension.ts` becomes a thin async entry (pi awaits async factories — verified against pi's extensions doc) that builds a provider registry (native + plugins loaded via our own jiti instance), validates `SEARCH_PROVIDERS`, and registers the three tools around a pure chain engine. The chain engine (`src/chain.ts`) is a pure function over an injectable provider list — no I/O knowledge, fully unit-testable offline.

**Tech Stack:** TypeScript (erasable-syntax only — Node native type stripping for tests), `node:test` (zero new dev deps), `jiti` ^2 (only new runtime dep), typebox (provided by pi at runtime).

**Spec:** `docs/superpowers/specs/2026-08-25-provider-plugin-foundation-design.md` (Approved). Example plugins port from PR #4 (diff saved at `/tmp/pr4.diff` during planning; re-fetch with `gh pr diff 4 --repo czhiming-maker/pi-deep-research` if needed).

## Global Constraints

- Spec contract verbatim: `SearchResult{title,url,snippet,score?,publishedDate?}`, `ExtractResult{title,url,content,author?,publishedDate?,wordCount,provider}`, `SearchRequest{query,maxResults,searchDepth?,signal?}`, `SearchProvider{name,tier,isConfigured(),search(req),extract?(url,signal?)}`.
  - **Spec clarification (resolved):** spec mandates a chain-enforced 30s timeout on `extract()` but its `extract?(url: string)` signature has no signal channel. Resolution: `extract?(url: string, signal?: AbortSignal)`. Positional `url` preserved.
- Plugin dir: `~/.pi/agent/deep-research/providers/*.ts` (global only). Missing dir = normal, empty registry, never an error.
- `SEARCH_PROVIDERS`: comma-separated ordered list; default `tavily,brave`; normalize trim/lowercase/drop-empties/dedupe-keep-first; unknown name → startup error listing unknown + all available names.
- Chain semantics (uniform): `isConfigured()===false` → skipped; ≥1 result after domain filtering → win; empty → continue; throw → continue; exhausted → aggregated error listing every attempt. All-skipped → the friendly "No search API configured…" message + `SEARCH_PROVIDERS` pointer.
- Timeout: 30_000ms default, injectable as `timeoutMs` for tests. Hung provider fails over (Promise.race on the abort signal), never blocks the chain.
- Successful search output byte-identical to v0.1.6 happy path. Zero-result/error output appends `Attempts: a → error (msg), b → empty` summary.
- Domain filter: client-side, uniform, subdomain-aware (`example.com` matches `www.example.com`, not `notexample.com`), applied after provider return, before `slice(0, maxResults)`, no backfill.
- Extract chain: ordered walk; first configured provider that has `extract()` wins; blank `content` counts as failure → continue; none → basic HTTP fetch fallback (provider label `fetch (basic)`); output gains `**Provider:** X` line.
- Batch: parallel per query; per-query failures surfaced (`### "q" (0 results) — ⚠️ all providers failed` + italic message); header lists providers actually used.
- Erasable TS only (no enums/namespaces/parameter-properties). Relative imports MUST use explicit `.ts` extensions (Node type-stripping requirement; jiti handles it too).
- Env reads happen inside `isConfigured()`/`search()` (call time), never at module load — allows test env manipulation.
- No changes to the `pi` field of package.json; entry stays `./extension.ts`.
- Repo convention: commit directly to `main`, message style `type: description` (e.g. `feat:`, `test:`, `docs:`). Never push without explicit user request.
- `research_checkpoint` tool is ported byte-identical from current `extension.ts:309-499` — do not "improve" it.

---

### Task 1: Contract types + shared helpers (TDD)

**Files:**
- Create: `src/types.ts`
- Create: `src/shared.ts`
- Create: `test/shared.test.ts`
- Modify: `package.json` (test script, jiti dependency, `files`)
- Create: `.gitignore` entry for `node_modules/` (verify first)

**Interfaces:**
- Produces (consumed by every later task):
  - `src/types.ts`: `SearchResult`, `ExtractResult`, `SearchRequest`, `SearchProvider`, `Attempt {provider: string; status: "skipped"|"empty"|"error"; reason?: string; message?: string}`
  - `src/shared.ts`: `MAX_WORDS = 8000`, `truncateToWords(content: string): {content: string; wordCount: number}`, `hostMatches(host: string, domain: string): boolean`, `applyDomainFilter(results: SearchResult[], include?: string[], exclude?: string[]): SearchResult[]`, `pickMeta(meta: Record<string, unknown> | undefined, keys: string[]): string | undefined`, `extractWithFetch(url: string, fetchImpl?: typeof fetch): Promise<ExtractResult>`

- [x] **Step 1: Scaffolding**

```bash
cd /Users/sicily/workspace/pi-deep-research
npm install jiti@^2
```

package.json edits (keep all other fields; final state of the changed keys):

```json
{
  "version": "0.1.6",
  "files": [
    "pi-deep-research/SKILL.md",
    "extension.ts",
    "src/",
    "examples/",
    "prompts/",
    "references/",
    "CHANGELOG.md",
    "LICENSE",
    "README.md"
  ],
  "scripts": {
    "test": "node --test test/"
  },
  "dependencies": {
    "jiti": "^2.6.1"
  }
}
```

(Version bump to 0.3.0 happens in Task 7, not here.) Ensure `.gitignore` contains `node_modules/` (create/append if missing).

- [x] **Step 2: Write `src/types.ts`** (spec contract verbatim + Attempt)

```ts
/** Provider contract — the v1 public API for native providers and drop-in plugins. */

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
	provider: string; // name of the provider that produced this
}

export interface SearchRequest {
	query: string;
	maxResults: number;
	searchDepth?: "basic" | "advanced"; // optional hint; providers may ignore
	signal?: AbortSignal; // chain-enforced timeout
}

export interface SearchProvider {
	name: string; // unique, lowercase [a-z0-9-]
	tier: "local" | "cloud"; // metadata for output/observability only — never drives logic
	isConfigured(): boolean; // false → skipped, recorded in attempts
	search(req: SearchRequest): Promise<SearchResult[]>; // throw = failure; empty array = success
	extract?(url: string, signal?: AbortSignal): Promise<ExtractResult>; // optional capability
}

/** One step of a chain walk — attached to every result and failure. */
export interface Attempt {
	provider: string;
	status: "skipped" | "empty" | "error";
	reason?: string; // for skipped
	message?: string; // for error
}
```

- [x] **Step 3: Write the failing test `test/shared.test.ts`**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyDomainFilter, hostMatches, pickMeta, truncateToWords } from "../src/shared.ts";

describe("hostMatches", () => {
	it("matches exact host (case-insensitive)", () => {
		assert.equal(hostMatches("Example.COM", "example.com"), true);
	});
	it("matches subdomains", () => {
		assert.equal(hostMatches("www.example.com", "example.com"), true);
		assert.equal(hostMatches("a.b.example.com", "example.com"), true);
	});
	it("does not match suffix-lookalikes", () => {
		assert.equal(hostMatches("notexample.com", "example.com"), false);
		assert.equal(hostMatches("example.com.evil.io", "example.com"), false);
	});
	it("tolerates leading dots in the filter domain", () => {
		assert.equal(hostMatches("www.example.com", ".example.com"), true);
	});
});

describe("applyDomainFilter", () => {
	const results = [
		{ title: "a", url: "https://www.example.com/a", snippet: "" },
		{ title: "b", url: "https://docs.example.org/b", snippet: "" },
		{ title: "c", url: "https://other.net/c", snippet: "" },
	];
	it("passthrough when no filters", () => {
		assert.equal(applyDomainFilter(results).length, 3);
	});
	it("include keeps only matching domains", () => {
		assert.deepEqual(
			applyDomainFilter(results, ["example.org"]).map((r) => r.url),
			["https://docs.example.org/b"],
		);
	});
	it("include is subdomain-aware", () => {
		assert.equal(applyDomainFilter(results, ["example.com"]).length, 1);
	});
	it("exclude removes matching domains", () => {
		assert.equal(applyDomainFilter(results, undefined, ["example.com", "example.org"]).length, 1);
	});
	it("unparseable URL fails the include list but survives without filters", () => {
		const bad = [{ title: "x", url: "not a url", snippet: "" }];
		assert.equal(applyDomainFilter(bad, ["example.com"]).length, 0);
		assert.equal(applyDomainFilter(bad).length, 1);
	});
});

describe("truncateToWords", () => {
	it("returns short content unchanged with correct count", () => {
		const r = truncateToWords("one two three");
		assert.deepEqual(r, { content: "one two three", wordCount: 3 });
	});
	it("preserves newlines and markdown up to the cut", () => {
		const para = Array(4000).fill("word").join(" ");
		const long = `# Title\n\n${para}\n\n## Section\n\n${para}\n\n${para}`;
		const r = truncateToWords(long);
		assert.ok(r.content.startsWith("# Title\n"));
		assert.ok(r.content.includes("## Section"));
		assert.ok(r.content.endsWith(`\n\n[... truncated, total ${r.wordCount} words]`));
		assert.ok(r.wordCount > 8000);
		// the kept portion is at most 8000 words
		assert.equal(r.content.replace(/\n\n\[.*\]$/, "").split(/\s+/).filter(Boolean).length, 8000);
	});
	it("exact boundary content is not truncated", () => {
		const exact = Array(8000).fill("w").join(" ");
		const r = truncateToWords(exact);
		assert.ok(!r.content.includes("truncated"));
		assert.equal(r.wordCount, 8000);
	});
});

describe("pickMeta", () => {
	it("returns first non-empty string across keys", () => {
		assert.equal(pickMeta({ author: "", "article:author": "Ada" }, ["author", "article:author"]), "Ada");
	});
	it("reads first element of array values", () => {
		assert.equal(pickMeta({ author: ["Ada", "Bob"] }, ["author"]), "Ada");
	});
	it("returns undefined when nothing matches", () => {
		assert.equal(pickMeta({ x: 1 }, ["author"]), undefined);
		assert.equal(pickMeta(undefined, ["author"]), undefined);
	});
});
```

- [x] **Step 4: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../src/shared.ts`.

- [x] **Step 5: Write `src/shared.ts`** (ports of PR #4 helpers + the basic-fetch extractor)

```ts
import type { ExtractResult, SearchResult } from "./types.ts";

export const MAX_WORDS = 8000;

/** Truncate to MAX_WORDS, preserving the original text (incl. markdown/newlines) up to the cut. */
export function truncateToWords(content: string): { content: string; wordCount: number } {
	const re = /\S+/g;
	let count = 0;
	let cutIdx = -1;
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null) {
		count++;
		if (count === MAX_WORDS) cutIdx = m.index + m[0].length;
	}
	if (count <= MAX_WORDS) return { content, wordCount: count };
	return { content: content.slice(0, cutIdx) + `\n\n[... truncated, total ${count} words]`, wordCount: count };
}

/** Subdomain-aware host match: example.com matches www.example.com but not notexample.com. */
export function hostMatches(host: string, domain: string): boolean {
	const h = host.toLowerCase();
	const d = domain.toLowerCase().replace(/^\.+/, "");
	return h === d || h.endsWith("." + d);
}

/** Filter results by include/exclude domains client-side, so every provider honors the filter uniformly. */
export function applyDomainFilter(results: SearchResult[], include?: string[], exclude?: string[]): SearchResult[] {
	if (!include?.length && !exclude?.length) return results;
	return results.filter((r) => {
		let host: string | null = null;
		try {
			host = new URL(r.url).hostname;
		} catch {
			/* unparseable URL */
		}
		if (include?.length && !(host && include.some((d) => hostMatches(host!, d)))) return false;
		if (exclude?.length && host && exclude.some((d) => hostMatches(host!, d))) return false;
		return true;
	});
}

/** First non-empty metadata value across candidate keys (providers pass raw meta keys straight through). */
export function pickMeta(meta: Record<string, unknown> | undefined, keys: string[]): string | undefined {
	if (!meta) return undefined;
	for (const k of keys) {
		const v = meta[k];
		if (typeof v === "string" && v.trim()) return v;
		if (Array.isArray(v) && typeof v[0] === "string" && v[0].trim()) return v[0];
	}
	return undefined;
}

/** Terminal extract fallback: plain fetch + regex stripping (unchanged behavior from v0.1.6). */
export async function extractWithFetch(url: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<ExtractResult> {
	const resp = await fetchImpl(url, {
		headers: {
			"User-Agent": "Mozilla/5.0 (compatible; PiDeepResearch/1.0)",
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		},
		redirect: "follow",
		signal: AbortSignal.timeout(15000),
	});

	if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);

	const html = await resp.text();

	const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
	const title = titleMatch?.[1]?.replace(/&[^;]+;/g, " ").trim() ?? "";

	const content = html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<nav[\s\S]*?<\/nav>/gi, "")
		.replace(/<header[\s\S]*?<\/header>/gi, "")
		.replace(/<footer[\s\S]*?<\/footer>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&[^;]+;/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	const { content: truncated, wordCount } = truncateToWords(content);

	const authorMatch = html.match(/<meta[^>]*name=["']author["'][^>]*content=["']([^"']+)["']/i);
	const author = authorMatch?.[1];
	const dateMatch = html.match(
		/<meta[^>]*(?:property=["']article:published_time["']|name=["']date["'])[^>]*content=["']([^"']+)["']/i,
	);
	const publishedDate = dateMatch?.[1];

	return { title, url, content: truncated, author, publishedDate, wordCount, provider: "fetch (basic)" };
}
```

- [x] **Step 6: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all shared tests green (loader/chain/etc. don't exist yet; only shared.test.ts runs).

- [x] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore src/types.ts src/shared.ts test/shared.test.ts
git commit -m "feat: provider contract types + shared helpers (domain filter, structure-preserving truncation, fetch extractor)"
```

---

### Task 2: Config parsing + chain resolution (TDD)

**Files:**
- Create: `src/config.ts`
- Create: `test/config.test.ts`

**Interfaces:**
- Consumes: `SearchProvider` from `src/types.ts`.
- Produces:
  - `DEFAULT_PROVIDERS: string[]` (value `["tavily", "brave"]`)
  - `parseProviderList(raw: string | undefined): string[]` — normalized ordered list; `undefined`/blank → default; all-entries-empty after normalization → default (defensive)
  - `resolveChain(registry: SearchProvider[], order: string[]): SearchProvider[]` — throws `Error` naming the unknown provider and listing all available names (sorted, comma-separated)

- [x] **Step 1: Write the failing test `test/config.test.ts`**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PROVIDERS, parseProviderList, resolveChain } from "../src/config.ts";
import type { SearchProvider } from "../src/types.ts";

function fake(name: string): SearchProvider {
	return {
		name,
		tier: "cloud",
		isConfigured: () => true,
		search: async () => [],
	};
}

describe("parseProviderList", () => {
	it("defaults to tavily,brave when unset", () => {
		assert.deepEqual(parseProviderList(undefined), ["tavily", "brave"]);
	});
	it("defaults on blank and all-empty-entry input", () => {
		assert.deepEqual(parseProviderList(""), DEFAULT_PROVIDERS.slice());
		assert.deepEqual(parseProviderList(" , , "), DEFAULT_PROVIDERS.slice());
	});
	it("trims and lowercases", () => {
		assert.deepEqual(parseProviderList(" Firecrawl , SEARXNG "), ["firecrawl", "searxng"]);
	});
	it("drops empty entries", () => {
		assert.deepEqual(parseProviderList("a,,b"), ["a", "b"]);
	});
	it("dedupes keeping first occurrence", () => {
		assert.deepEqual(parseProviderList("brave,tavily,brave"), ["brave", "tavily"]);
	});
});

describe("resolveChain", () => {
	const registry = [fake("tavily"), fake("brave"), fake("searxng")];
	it("resolves in the given order", () => {
		assert.deepEqual(
			resolveChain(registry, ["searxng", "tavily"]).map((p) => p.name),
			["searxng", "tavily"],
		);
	});
	it("empty order yields empty chain", () => {
		assert.deepEqual(resolveChain(registry, []), []);
	});
	it("unknown name throws listing unknown + available names", () => {
		assert.throws(() => resolveChain(registry, ["tavily", "nope"]), (e: Error) => {
			assert.match(e.message, /unknown provider "nope"/);
			assert.match(e.message, /brave, searxng, tavily/);
			return true;
		});
	});
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../src/config.ts`.

- [x] **Step 3: Write `src/config.ts`**

```ts
import type { SearchProvider } from "./types.ts";

export const DEFAULT_PROVIDERS = ["tavily", "brave"];

/**
 * Parse SEARCH_PROVIDERS: comma-separated, ordered provider names.
 * Normalization: trim, lowercase, drop empty entries, dedupe keeping the
 * first occurrence. Blank/all-empty input falls back to the default list —
 * the list defines both the SET and the ORDER of the chain (air-gap users
 * simply list only local providers; cloud never enters the chain).
 */
export function parseProviderList(raw: string | undefined): string[] {
	if (!raw?.trim()) return [...DEFAULT_PROVIDERS];
	const seen = new Set<string>();
	for (const entry of raw.split(",")) {
		const name = entry.trim().toLowerCase();
		if (name) seen.add(name);
	}
	return seen.size > 0 ? [...seen] : [...DEFAULT_PROVIDERS];
}

/**
 * Map an ordered name list onto registry providers.
 * Fail fast: an unknown name is a configuration error — the message lists
 * the unknown name and every available provider so the user can self-correct.
 */
export function resolveChain(registry: SearchProvider[], order: string[]): SearchProvider[] {
	const byName = new Map(registry.map((p) => [p.name, p]));
	const chain: SearchProvider[] = [];
	for (const name of order) {
		const provider = byName.get(name);
		if (!provider) {
			const available = registry
				.map((p) => p.name)
				.sort()
				.join(", ");
			throw new Error(
				`SEARCH_PROVIDERS references unknown provider "${name}". Available providers: ${available}. ` +
					`Custom providers are .ts files dropped into ~/.pi/agent/deep-research/providers/ (see README → Custom Search Providers).`,
			);
		}
		chain.push(provider);
	}
	return chain;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (shared + config suites).

- [x] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: SEARCH_PROVIDERS parsing + ordered chain resolution with fail-fast validation"
```

---

### Task 3: Chain engine (TDD)

**Files:**
- Create: `src/chain.ts`
- Create: `test/chain.test.ts`

**Interfaces:**
- Consumes: `applyDomainFilter`, `extractWithFetch` from `src/shared.ts`; types from `src/types.ts`.
- Produces:
  - `DEFAULT_TIMEOUT_MS = 30_000`
  - `class ChainError extends Error { attempts: Attempt[] }`
  - `formatAttempts(attempts: Attempt[]): string` — `"tavily → error (401), brave → empty, x → skipped (not configured)"`
  - `NO_SEARCH_API_MESSAGE: string` (friendly no-config error incl. `SEARCH_PROVIDERS` pointer)
  - `chainSearch(chain: SearchProvider[], query: string, opts: { maxResults: number; searchDepth?: "basic"|"advanced"; includeDomains?: string[]; excludeDomains?: string[]; timeoutMs?: number }): Promise<{provider: string; results: SearchResult[]; attempts: Attempt[]}>` — throws `ChainError`
  - `chainExtract(chain: SearchProvider[], url: string, opts?: { timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<ExtractResult>`
  - `chainBatchSearch(chain: SearchProvider[], queries: string[], opts: same as chainSearch): Promise<{results: Record<string, SearchResult[]>; providers: string[]; failures: Record<string, string>}>`

- [x] **Step 1: Write the failing test `test/chain.test.ts`**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chainBatchSearch, chainExtract, chainSearch, formatAttempts } from "../src/chain.ts";
import type { ExtractResult, SearchProvider, SearchResult } from "../src/types.ts";

const hit = (url: string): SearchResult => ({ title: `t ${url}`, url, snippet: "s" });

function provider(over: Partial<SearchProvider> & { name: string }): SearchProvider {
	return {
		tier: "cloud",
		isConfigured: () => true,
		search: async () => [],
		...over,
	};
}

const extractResult = (content: string): ExtractResult => ({
	title: "T", url: "https://x", content, wordCount: content.split(/\s+/).length, provider: "stub",
});

describe("chainSearch", () => {
	it("first non-empty result wins", async () => {
		const a = provider({ name: "a", search: async () => [hit("https://a")] });
		const b = provider({ name: "b", search: async () => [hit("https://b")] });
		const r = await chainSearch([a, b], "q", { maxResults: 5 });
		assert.equal(r.provider, "a");
		assert.equal(r.results.length, 1);
		assert.equal(r.attempts.length, 0); // win recorded before any attempt entry
	});
	it("unconfigured provider is skipped with reason, chain continues", async () => {
		const a = provider({ name: "a", isConfigured: () => false });
		const b = provider({ name: "b", search: async () => [hit("https://b")] });
		const r = await chainSearch([a, b], "q", { maxResults: 5 });
		assert.equal(r.provider, "b");
		assert.deepEqual(r.attempts, [{ provider: "a", status: "skipped", reason: "not configured" }]);
	});
	it("erroring provider fails over to the next", async () => {
		const a = provider({ name: "a", search: async () => { throw new Error("401 Unauthorized"); } });
		const b = provider({ name: "b", search: async () => [hit("https://b")] });
		const r = await chainSearch([a, b], "q", { maxResults: 5 });
		assert.equal(r.provider, "b");
		assert.equal(r.attempts[0].status, "error");
		assert.equal(r.attempts[0].message, "401 Unauthorized");
	});
	it("empty result continues; all empty → ChainError with attempts summary", async () => {
		const a = provider({ name: "a", search: async () => [] });
		const b = provider({ name: "b", search: async () => [] });
		await assert.rejects(chainSearch([a, b], "q", { maxResults: 5 }), (e: Error & { attempts?: unknown }) => {
			assert.match(e.message, /No search provider produced results for query "q"/);
			assert.match(e.message, /Attempts: a → empty, b → empty/);
			assert.ok(Array.isArray(e.attempts));
			return true;
		});
	});
	it("all skipped → friendly no-config message with SEARCH_PROVIDERS pointer", async () => {
		const a = provider({ name: "a", isConfigured: () => false });
		const b = provider({ name: "b", isConfigured: () => false });
		await assert.rejects(chainSearch([a, b], "q", { maxResults: 5 }), (e: Error) => {
			assert.match(e.message, /No search API configured/);
			assert.match(e.message, /SEARCH_PROVIDERS/);
			return true;
		});
	});
	it("domain filtering applies before the win check; filtered-to-zero continues the chain", async () => {
		const a = provider({ name: "a", search: async () => [hit("https://keep.com/1"), hit("https://drop.net/2")] });
		const r = await chainSearch([a], "q", { maxResults: 5, includeDomains: ["keep.com"] });
		assert.equal(r.provider, "a");
		assert.equal(r.results.length, 1);
		const b = provider({ name: "b", search: async () => [hit("https://x")] });
		await assert.rejects(chainSearch([b], "q", { maxResults: 5, excludeDomains: ["x"] }), /empty/);
	});
	it("slices to maxResults after filtering", async () => {
		const a = provider({
			name: "a",
			search: async () => [hit("https://1"), hit("https://2"), hit("https://3")],
		});
		const r = await chainSearch([a], "q", { maxResults: 2 });
		assert.equal(r.results.length, 2);
	});
	it("hung provider times out and fails over (injectable timeoutMs)", async () => {
		const a = provider({ name: "a", search: () => new Promise(() => {}) }); // never settles
		const b = provider({ name: "b", search: async () => [hit("https://b")] });
		const r = await chainSearch([a, b], "q", { maxResults: 5, timeoutMs: 50 });
		assert.equal(r.provider, "b");
		assert.equal(r.attempts[0].status, "error");
		assert.match(r.attempts[0].message!, /timed out after 50ms/);
	});
	it("search receives query, maxResults, searchDepth and a live signal", async () => {
		let seen: unknown;
		const a = provider({
			name: "a",
			search: async (req) => {
				seen = req;
				return [hit("https://a")];
			},
		});
		await chainSearch([a], "q", { maxResults: 3, searchDepth: "advanced" });
		assert.equal((seen as { query: string }).query, "q");
		assert.equal((seen as { maxResults: number }).maxResults, 3);
		assert.equal((seen as { searchDepth?: string }).searchDepth, "advanced");
		assert.ok((seen as { signal?: AbortSignal }).signal instanceof AbortSignal);
	});
});

describe("formatAttempts", () => {
	it("renders the spec format", () => {
		const s = formatAttempts([
			{ provider: "tavily", status: "error", message: "401 Unauthorized" },
			{ provider: "brave", status: "empty" },
			{ provider: "x", status: "skipped", reason: "not configured" },
		]);
		assert.equal(s, "tavily → error (401 Unauthorized), brave → empty, x → skipped (not configured)");
	});
});

describe("chainExtract", () => {
	it("uses the first configured provider that has extract()", async () => {
		const a = provider({ name: "a" }); // no extract capability
		const b = provider({ name: "b", extract: async () => extractResult("hello") });
		const r = await chainExtract([a, b], "https://x");
		assert.equal(r.provider, "b");
		assert.equal(r.content, "hello");
	});
	it("skips unconfigured providers even if they have extract()", async () => {
		const a = provider({ name: "a", isConfigured: () => false, extract: async () => extractResult("nope") });
		const b = provider({ name: "b", extract: async () => extractResult("yes") });
		const r = await chainExtract([a, b], "https://x");
		assert.equal(r.provider, "b");
	});
	it("blank content counts as failure → next provider", async () => {
		const a = provider({ name: "a", extract: async () => extractResult("   ") });
		const b = provider({ name: "b", extract: async () => extractResult("real") });
		const r = await chainExtract([a, b], "https://x");
		assert.equal(r.provider, "b");
	});
	it("throwing extract fails over; provider name is normalized on success", async () => {
		const a = provider({ name: "a", extract: async () => { throw new Error("boom"); } });
		const b = provider({ name: "b", extract: async () => ({ ...extractResult("ok"), provider: "wrong-label" }) });
		const r = await chainExtract([a, b], "https://x");
		assert.equal(r.provider, "b");
	});
	it("no capable provider → injectable fetch fallback", async () => {
		const html =
			"<html><head><title>Page</title>" +
			'<meta name="author" content="Ada"></head>' +
			"<body><nav>x</nav><p>hello world</p></body></html>";
		const fetchImpl = (async () => new Response(html, { status: 200 })) as typeof fetch;
		const r = await chainExtract([provider({ name: "a" })], "https://x", { fetchImpl });
		assert.equal(r.provider, "fetch (basic)");
		assert.equal(r.title, "Page");
		assert.equal(r.author, "Ada");
		assert.equal(r.content, "hello world");
	});
});

describe("chainBatchSearch", () => {
	it("runs queries in parallel, collects providers used and per-query failures", async () => {
		const ok = provider({ name: "ok", search: async () => [hit("https://ok")] });
		await assert.rejects(chainSearch([provider({ name: "e", search: async () => [] })], "x", { maxResults: 5 }), /.*/);
		const empty = provider({ name: "e", search: async () => [] });
		const out = await chainBatchSearch([ok, empty], ["good", "bad"], { maxResults: 5 });
		assert.deepEqual(out.results["good"].map((r) => r.url), ["https://ok"]);
		assert.deepEqual(out.results["bad"], []);
		assert.deepEqual(out.providers, ["ok"]);
		assert.match(out.failures["bad"], /No search provider produced results/);
	});
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../src/chain.ts`.

- [x] **Step 3: Write `src/chain.ts`**

```ts
import { applyDomainFilter, extractWithFetch } from "./shared.ts";
import type { Attempt, ExtractResult, SearchProvider, SearchResult } from "./types.ts";

export const DEFAULT_TIMEOUT_MS = 30_000;

export const NO_SEARCH_API_MESSAGE =
	"No search API configured. Set TAVILY_API_KEY or BRAVE_API_KEY environment variable.\n" +
	"  Tavily: https://tavily.com (free: 1000 req/month)\n" +
	"  Brave:  https://brave.com/search/api/ (free: 2000 req/month)\n" +
	"To use custom search providers, set SEARCH_PROVIDERS and drop a plugin into ~/.pi/agent/deep-research/providers/ (see README → Custom Search Providers).";

export class ChainError extends Error {
	attempts: Attempt[];
	constructor(message: string, attempts: Attempt[]) {
		super(message);
		this.name = "ChainError";
		this.attempts = attempts;
	}
}

export function formatAttempts(attempts: Attempt[]): string {
	return attempts
		.map((a) => {
			if (a.status === "skipped") return `${a.provider} → skipped (${a.reason ?? "not configured"})`;
			if (a.status === "empty") return `${a.provider} → empty`;
			return `${a.provider} → error (${a.message ?? "unknown error"})`;
		})
		.join(", ");
}

/** Reject with a timeout error when the signal fires, even if the provider ignores it. */
function raceTimeout<T>(p: Promise<T>, signal: AbortSignal, ms: number): Promise<T> {
	return Promise.race([
		p,
		new Promise<never>((_, reject) => {
			const abort = () => reject(new Error(`timed out after ${ms}ms`));
			if (signal.aborted) return abort();
			signal.addEventListener("abort", abort, { once: true });
		}),
	]);
}

export interface ChainSearchOptions {
	maxResults: number;
	searchDepth?: "basic" | "advanced";
	includeDomains?: string[];
	excludeDomains?: string[];
	timeoutMs?: number;
}

export interface ChainSearchResult {
	provider: string;
	results: SearchResult[];
	attempts: Attempt[];
}

/**
 * Uniform chain semantics — the same rule for every provider, no tier asymmetry:
 *   isConfigured() false → skipped · ≥1 result after domain filtering → win ·
 *   empty → continue · throw → continue · exhausted → aggregated ChainError.
 * All-skipped (nothing configured) yields the friendly no-config message.
 */
export async function chainSearch(
	chain: SearchProvider[],
	query: string,
	opts: ChainSearchOptions,
): Promise<ChainSearchResult> {
	const attempts: Attempt[] = [];
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	for (const provider of chain) {
		if (!provider.isConfigured()) {
			attempts.push({ provider: provider.name, status: "skipped", reason: "not configured" });
			continue;
		}
		const signal = AbortSignal.timeout(timeoutMs);
		try {
			const raw = await raceTimeout(
				provider.search({ query, maxResults: opts.maxResults, searchDepth: opts.searchDepth, signal }),
				signal,
				timeoutMs,
			);
			const results = applyDomainFilter(raw, opts.includeDomains, opts.excludeDomains).slice(0, opts.maxResults);
			if (results.length > 0) return { provider: provider.name, results, attempts };
			attempts.push({ provider: provider.name, status: "empty" });
		} catch (e) {
			attempts.push({ provider: provider.name, status: "error", message: e instanceof Error ? e.message : String(e) });
		}
	}

	if (attempts.length > 0 && attempts.every((a) => a.status === "skipped")) {
		throw new ChainError(NO_SEARCH_API_MESSAGE, attempts);
	}
	throw new ChainError(
		`No search provider produced results for query "${query}". Attempts: ${formatAttempts(attempts)}`,
		attempts,
	);
}

export interface ChainExtractOptions {
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

/**
 * Walk the chain in order; the first configured provider that has extract()
 * handles the URL. Blank/empty content counts as failure (a hollow 200 is not
 * a usable extract) → continue. If no provider is capable, fall back to the
 * basic HTTP fetch extractor.
 */
export async function chainExtract(
	chain: SearchProvider[],
	url: string,
	opts: ChainExtractOptions = {},
): Promise<ExtractResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	for (const provider of chain) {
		if (!provider.isConfigured() || typeof provider.extract !== "function") continue;
		const signal = AbortSignal.timeout(timeoutMs);
		try {
			const raw = await raceTimeout(Promise.resolve(provider.extract(url, signal)), signal, timeoutMs);
			if (!raw?.content?.trim()) {
				console.warn(`[pi-deep-research] ${provider.name} extract returned no content for ${url}`);
				continue;
			}
			return { ...raw, provider: provider.name };
		} catch (e) {
			console.warn(`[pi-deep-research] ${provider.name} extract failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	return extractWithFetch(url, opts.fetchImpl);
}

export interface BatchOutcome {
	results: Record<string, SearchResult[]>;
	providers: string[];
	failures: Record<string, string>;
}

/** Run the search chain per query in parallel; failures are surfaced per query, never swallowed. */
export async function chainBatchSearch(
	chain: SearchProvider[],
	queries: string[],
	opts: ChainSearchOptions,
): Promise<BatchOutcome> {
	const settled = await Promise.allSettled(queries.map((q) => chainSearch(chain, q, opts)));
	const used = new Set<string>();
	const results: Record<string, SearchResult[]> = {};
	const failures: Record<string, string> = {};
	settled.forEach((s, i) => {
		const q = queries[i];
		if (s.status === "fulfilled") {
			used.add(s.value.provider);
			results[q] = s.value.results;
		} else {
			results[q] = [];
			failures[q] = s.reason instanceof Error ? s.reason.message : String(s.reason);
		}
	});
	return { results, providers: [...used], failures };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (shared + config + chain suites; chain timeout test completes in ~50ms).

- [x] **Step 5: Commit**

```bash
git add src/chain.ts test/chain.test.ts
git commit -m "feat: pure provider chain engine (uniform semantics, attempts log, fail-over timeout, extract fallback)"
```

---

### Task 4: Native providers — Tavily + Brave (TDD)

**Files:**
- Create: `src/native/tavily.ts`
- Create: `src/native/brave.ts`
- Create: `test/native.test.ts`

**Interfaces:**
- Consumes: `SearchProvider`, `SearchRequest`, `SearchResult` from `src/types.ts`.
- Produces:
  - `createTavilyProvider(fetchImpl?: typeof fetch): SearchProvider` (name `tavily`, tier `cloud`)
  - `createBraveProvider(fetchImpl?: typeof fetch): SearchProvider` (name `brave`, tier `cloud`)
  - Both read their env key at call time (`isConfigured()` and inside `search()`), forward `req.signal` to fetch, and map responses exactly as v0.1.6 did. Deliberate delta (per spec): include/exclude domains are NOT sent to the Tavily API — filtering is client-side and uniform now.

- [x] **Step 1: Write the failing test `test/native.test.ts`**

```ts
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createBraveProvider, createTavilyProvider } from "../src/native/index.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let calls: Array<{ url: string; init: RequestInit }> = [];
function mockFetch(resp: (url: string) => Response): typeof fetch {
	return (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		return resp(String(url));
	}) as typeof fetch;
}

beforeEach(() => {
	calls = [];
	process.env.TAVILY_API_KEY = "tvly-test";
	process.env.BRAVE_API_KEY = "BSA-test";
});
afterEach(() => {
	delete process.env.TAVILY_API_KEY;
	delete process.env.BRAVE_API_KEY;
});

describe("tavily", () => {
	it("maps the response to SearchResult (content→snippet, published_date→publishedDate)", async () => {
		const f = mockFetch(() =>
			jsonResponse({
				results: [{ title: "T", url: "https://x", content: "snippet text", score: 0.87, published_date: "2026-01-02" }],
			}),
		);
		const r = await createTavilyProvider(f).search({ query: "q", maxResults: 5 });
		assert.deepEqual(r, [{ title: "T", url: "https://x", snippet: "snippet text", score: 0.87, publishedDate: "2026-01-02" }]);
	});
	it("sends auth header, JSON body with query/max_results/search_depth/include_answer", async () => {
		const f = mockFetch(() => jsonResponse({ results: [] }));
		await createTavilyProvider(f).search({ query: "hello", maxResults: 7, searchDepth: "advanced" });
		assert.equal(calls[0].url, "https://api.tavily.com/search");
		assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer tvly-test");
		const body = JSON.parse(calls[0].init.body as string);
		assert.equal(body.query, "hello");
		assert.equal(body.max_results, 7);
		assert.equal(body.search_depth, "advanced");
		assert.equal(body.include_answer, false);
	});
	it("does NOT send domain filters to the API (client-side filtering is uniform now)", async () => {
		const f = mockFetch(() => jsonResponse({ results: [] }));
		await createTavilyProvider(f).search({ query: "q", maxResults: 5 });
		const body = JSON.parse(calls[0].init.body as string);
		assert.ok(!("include_domains" in body) && !("exclude_domains" in body));
	});
	it("forwards the abort signal to fetch", async () => {
		const f = mockFetch(() => jsonResponse({ results: [] }));
		const signal = AbortSignal.timeout(5000);
		await createTavilyProvider(f).search({ query: "q", maxResults: 5, signal });
		assert.equal(calls[0].init.signal, signal);
	});
	it("HTTP error → Error with status", async () => {
		const f = mockFetch(() => new Response("nope", { status: 401 }));
		await assert.rejects(createTavilyProvider(f).search({ query: "q", maxResults: 5 }), /Tavily API error 401/);
	});
	it("missing key → isConfigured false; search throws", async () => {
		delete process.env.TAVILY_API_KEY;
		const p = createTavilyProvider(mockFetch(() => jsonResponse({ results: [] })));
		assert.equal(p.isConfigured(), false);
		await assert.rejects(p.search({ query: "q", maxResults: 5 }), /TAVILY_API_KEY not set/);
	});
});

describe("brave", () => {
	it("maps web.results (description→snippet, age→publishedDate)", async () => {
		const f = mockFetch(() =>
			jsonResponse({ web: { results: [{ title: "T", url: "https://x", description: "d", age: "3 days ago" }] } }),
		);
		const r = await createBraveProvider(f).search({ query: "q", maxResults: 5 });
		assert.deepEqual(r, [{ title: "T", url: "https://x", snippet: "d", publishedDate: "3 days ago" }]);
	});
	it("sends q/count params and subscription token; tolerates missing web key", async () => {
		const f = mockFetch(() => jsonResponse({}));
		const r = await createBraveProvider(f).search({ query: "kw", maxResults: 3 });
		assert.deepEqual(r, []);
		assert.match(calls[0].url, /https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?q=kw&count=3/);
		assert.equal((calls[0].init.headers as Record<string, string>)["X-Subscription-Token"], "BSA-test");
	});
	it("HTTP error → Error with status; missing key → not configured", async () => {
		await assert.rejects(
			createBraveProvider(mockFetch(() => new Response("x", { status: 429 }))).search({ query: "q", maxResults: 5 }),
			/Brave API error 429/,
		);
		delete process.env.BRAVE_API_KEY;
		assert.equal(createBraveProvider().isConfigured(), false);
	});
});
```

Note the test imports from `../src/native/index.ts` — a barrel file keeps import paths stable.

- [x] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../src/native/index.ts`.

- [x] **Step 3: Write `src/native/tavily.ts`, `src/native/brave.ts`, `src/native/index.ts`**

`src/native/tavily.ts`:

```ts
import type { SearchProvider, SearchRequest, SearchResult } from "../types.ts";

interface TavilyResponse {
	results: Array<{ title: string; url: string; content: string; score: number; published_date?: string }>;
}

/** Native Tavily provider — same endpoint, params, and response mapping as v0.1.6. */
export function createTavilyProvider(fetchImpl: typeof fetch = globalThis.fetch): SearchProvider {
	return {
		name: "tavily",
		tier: "cloud",
		isConfigured: () => Boolean(process.env.TAVILY_API_KEY),
		async search(req: SearchRequest): Promise<SearchResult[]> {
			const apiKey = process.env.TAVILY_API_KEY;
			if (!apiKey) throw new Error("TAVILY_API_KEY not set");

			const body: Record<string, unknown> = {
				query: req.query,
				max_results: req.maxResults,
				search_depth: req.searchDepth ?? "basic",
				include_answer: false,
			};

			const resp = await fetchImpl("https://api.tavily.com/search", {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
				body: JSON.stringify(body),
				signal: req.signal,
			});

			if (!resp.ok) {
				const text = await resp.text();
				throw new Error(`Tavily API error ${resp.status}: ${text}`);
			}

			const data = (await resp.json()) as TavilyResponse;
			return data.results.map((r) => ({
				title: r.title,
				url: r.url,
				snippet: r.content,
				score: r.score,
				publishedDate: r.published_date,
			}));
		},
	};
}
```

`src/native/brave.ts`:

```ts
import type { SearchProvider, SearchRequest, SearchResult } from "../types.ts";

interface BraveResponse {
	web?: { results: Array<{ title: string; url: string; description: string; age?: string }> };
}

/** Native Brave provider — same endpoint, params, and response mapping as v0.1.6. */
export function createBraveProvider(fetchImpl: typeof fetch = globalThis.fetch): SearchProvider {
	return {
		name: "brave",
		tier: "cloud",
		isConfigured: () => Boolean(process.env.BRAVE_API_KEY),
		async search(req: SearchRequest): Promise<SearchResult[]> {
			const apiKey = process.env.BRAVE_API_KEY;
			if (!apiKey) throw new Error("BRAVE_API_KEY not set");

			const params = new URLSearchParams({ q: req.query, count: String(req.maxResults) });
			const resp = await fetchImpl(`https://api.search.brave.com/res/v1/web/search?${params}`, {
				headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": apiKey },
				signal: req.signal,
			});

			if (!resp.ok) {
				const text = await resp.text();
				throw new Error(`Brave API error ${resp.status}: ${text}`);
			}

			const data = (await resp.json()) as BraveResponse;
			return (data.web?.results ?? []).map((r) => ({
				title: r.title,
				url: r.url,
				snippet: r.description,
				publishedDate: r.age,
			}));
		},
	};
}
```

`src/native/index.ts`:

```ts
export { createTavilyProvider } from "./tavily.ts";
export { createBraveProvider } from "./brave.ts";
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (shared + config + chain + native suites).

- [x] **Step 5: Commit**

```bash
git add src/native test/native.test.ts
git commit -m "feat: native tavily + brave providers behind the SearchProvider contract"
```

---

### Task 5: Plugin loader (TDD)

**Files:**
- Create: `src/loader.ts`
- Create: `test/loader.test.ts`

**Interfaces:**
- Consumes: `SearchProvider` from `src/types.ts`; `Jiti` type + `createJiti` from `jiti`.
- Produces:
  - `providersDir(home?: string): string` — `<home>/.pi/agent/deep-research/providers` (defaults to `os.homedir()`)
  - `loadPlugins(dir: string, reserved: string[], jiti: Jiti): Promise<{providers: SearchProvider[]; warnings: string[]}>` — scans `*.ts` (excluding `*.d.ts`, sorted for determinism); missing dir (`ENOENT`) → empty result, never throws; per-file rules:
    - import throws → skip + warning
    - default export not `{name: string, search: function}` → skip + warning naming file + reason
    - name not matching `/^[a-z0-9-]+$/` → skip + warning
    - name in `reserved` (native) → skip + warning
    - duplicate plugin name → second skipped + warning naming BOTH files

- [x] **Step 1: Write the failing test `test/loader.test.ts`** (fixtures are real `.ts` files written to a temp dir, loaded with a real jiti instance — this is the same mechanism the extension uses)

```ts
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createJiti } from "jiti";
import { loadPlugins, providersDir } from "../src/loader.ts";

let dir: string;
const jiti = createJiti(import.meta.url);

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pidr-plugins-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writePlugin(file: string, code: string) {
	await writeFile(join(dir, file), code);
}

describe("loadPlugins", () => {
	it("valid plugin loads and is returned", async () => {
		await writePlugin(
			"good.ts",
			`export default {
				name: "good",
				tier: "local",
				isConfigured: () => Boolean(process.env.GOOD_URL),
				search: async () => [{ title: "t", url: "https://x", snippet: "s" }],
			};`,
		);
		const { providers, warnings } = await loadPlugins(dir, ["tavily", "brave"], jiti);
		assert.equal(providers.length, 1);
		assert.equal(providers[0].name, "good");
		assert.deepEqual(warnings, []);
	});
	it("missing directory → empty result, no warnings, no throw", async () => {
		const { providers, warnings } = await loadPlugins(join(dir, "does-not-exist"), [], jiti);
		assert.deepEqual(providers, []);
		assert.deepEqual(warnings, []);
	});
	it("invalid shape (no search function) → skipped with warning naming the file", async () => {
		await writePlugin("bad.ts", `export default { name: "bad", tier: "local" };`);
		const { providers, warnings } = await loadPlugins(dir, [], jiti);
		assert.equal(providers.length, 0);
		assert.match(warnings[0], /bad\.ts/);
		assert.match(warnings[0], /"search"/);
	});
	it("import-throwing plugin → skipped with warning", async () => {
		await writePlugin("throws.ts", `throw new Error("boom on import");`);
		const { providers, warnings } = await loadPlugins(dir, [], jiti);
		assert.equal(providers.length, 0);
		assert.match(warnings[0], /throws\.ts/);
		assert.match(warnings[0], /boom on import/);
	});
	it("native-name collision → skipped with warning", async () => {
		await writePlugin(
			"shadow.ts",
			`export default { name: "tavily", tier: "cloud", isConfigured: () => true, search: async () => [] };`,
		);
		const { providers, warnings } = await loadPlugins(dir, ["tavily"], jiti);
		assert.equal(providers.length, 0);
		assert.match(warnings[0], /shadow\.ts/);
		assert.match(warnings[0], /reserved/);
	});
	it("duplicate plugin names → second file skipped, warning names both files", async () => {
		await writePlugin(
			"a1.ts",
			`export default { name: "dup", tier: "local", isConfigured: () => true, search: async () => [] };`,
		);
		await writePlugin(
			"b2.ts",
			`export default { name: "dup", tier: "local", isConfigured: () => true, search: async () => [] };`,
		);
		const { providers, warnings } = await loadPlugins(dir, [], jiti);
		assert.equal(providers.length, 1);
		assert.equal(providers[0].name, "dup");
		assert.match(warnings[0], /b2\.ts/);
		assert.match(warnings[0], /a1\.ts/);
	});
	it("uppercase/invalid name → skipped with warning", async () => {
		await writePlugin(
			"upper.ts",
			`export default { name: "MyProvider", tier: "cloud", isConfigured: () => true, search: async () => [] };`,
		);
		const { providers, warnings } = await loadPlugins(dir, [], jiti);
		assert.equal(providers.length, 0);
		assert.match(warnings[0], /a-z0-9/);
	});
	it("ignores non-.ts and .d.ts files", async () => {
		await writePlugin("readme.md", "not a plugin");
		await writePlugin("types.d.ts", "export {};");
		const { providers, warnings } = await loadPlugins(dir, [], jiti);
		assert.deepEqual(providers, []);
		assert.deepEqual(warnings, []);
	});
});

describe("providersDir", () => {
	it("is <home>/.pi/agent/deep-research/providers", () => {
		assert.equal(providersDir("/home/u"), "/home/u/.pi/agent/deep-research/providers");
	});
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../src/loader.ts`.

- [x] **Step 3: Write `src/loader.ts`**

```ts
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Jiti } from "jiti";
import type { SearchProvider } from "./types.ts";

const NAME_RE = /^[a-z0-9-]+$/;

/** Global plugin directory (v1: global only — project-level dirs would bypass pi's project trust gate). */
export function providersDir(home: string = homedir()): string {
	return join(home, ".pi", "agent", "deep-research", "providers");
}

export interface LoadResult {
	providers: SearchProvider[];
	warnings: string[];
}

/**
 * Scan a directory for provider plugins (.ts files whose default export
 * conforms to SearchProvider) and load them via jiti. A missing directory is
 * normal (no plugins). Every failure mode skips the offending file with a
 * warning — one bad plugin never blocks startup.
 */
export async function loadPlugins(dir: string, reserved: string[], jiti: Jiti): Promise<LoadResult> {
	const warnings: string[] = [];
	const providers: SearchProvider[] = [];

	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { providers, warnings };
		throw e;
	}

	const files = entries.filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts")).sort();
	const claimedBy = new Map<string, string>(); // provider name → file that claimed it

	for (const file of files) {
		const path = join(dir, file);
		let mod: { default?: unknown };
		try {
			mod = (await jiti.import(path)) as { default?: unknown };
		} catch (e) {
			warnings.push(
				`[pi-deep-research] skipped provider plugin ${file}: import failed (${e instanceof Error ? e.message : String(e)})`,
			);
			continue;
		}

		const def = mod?.default;
		if (
			typeof def !== "object" ||
			def === null ||
			typeof (def as SearchProvider).name !== "string" ||
			typeof (def as SearchProvider).search !== "function"
		) {
			warnings.push(
				`[pi-deep-research] skipped provider plugin ${file}: default export must be an object with a string "name" and a "search" function`,
			);
			continue;
		}

		const provider = def as SearchProvider;
		if (!NAME_RE.test(provider.name)) {
			warnings.push(
				`[pi-deep-research] skipped provider plugin ${file}: name "${provider.name}" must be lowercase [a-z0-9-]`,
			);
			continue;
		}
		if (reserved.includes(provider.name)) {
			warnings.push(
				`[pi-deep-research] skipped provider plugin ${file}: name "${provider.name}" is reserved for the built-in provider`,
			);
			continue;
		}
		const first = claimedBy.get(provider.name);
		if (first) {
			warnings.push(
				`[pi-deep-research] skipped provider plugin ${file}: name "${provider.name}" already loaded from ${first}`,
			);
			continue;
		}

		claimedBy.set(provider.name, file);
		providers.push(provider);
	}

	return { providers, warnings };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all five suites so far).

- [x] **Step 5: Commit**

```bash
git add src/loader.ts test/loader.test.ts
git commit -m "feat: jiti-based plugin loader with per-file validation and collision handling"
```

---

### Task 6: Rewrite `extension.ts` as the thin entry

**Files:**
- Modify: `extension.ts` (full rewrite; `research_checkpoint` ported byte-identical from the current file, lines 309–499)

**Interfaces:**
- Consumes: everything produced by Tasks 1–5 (`chainSearch`, `chainBatchSearch`, `chainExtract`, `parseProviderList`, `resolveChain`, `loadPlugins`, `providersDir`, `createTavilyProvider`, `createBraveProvider`, `createJiti`).
- Produces: the extension entry itself — async default factory (pi awaits it; verified against pi's extensions doc), building a fresh registry per load so `/reload` re-scans the plugin dir (hot-plug).

No unit test in this task — the entry depends on pi runtime types; its logic is entirely delegated to the tested chain/config/loader modules. Verification is review + green suite + the Task 8 smoke.

- [x] **Step 1: Rewrite `extension.ts`**

```ts
/**
 * Deep Research Extension — web_search + web_extract + research_checkpoint tools
 *
 * Search and extraction run a provider chain configured via SEARCH_PROVIDERS
 * (ordered, comma-separated; default: tavily,brave — identical to v0.1.6).
 * Additional providers are hot-pluggable: drop a .ts file exporting a
 * SearchProvider into ~/.pi/agent/deep-research/providers/ and /reload.
 * See README → Custom Search Providers.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createJiti } from "jiti";
import { Type } from "@sinclair/typebox";
import { chainBatchSearch, chainExtract, chainSearch } from "./src/chain.ts";
import { parseProviderList, resolveChain } from "./src/config.ts";
import { loadPlugins, providersDir } from "./src/loader.ts";
import { createBraveProvider, createTavilyProvider } from "./src/native/index.ts";

export default async function (pi: ExtensionAPI) {
	// Registry = native providers + user plugins; rebuilt on every extension
	// load so /reload picks up plugin changes (pi awaits async factories).
	const native = [createTavilyProvider(), createBraveProvider()];
	const { providers: plugins, warnings } = await loadPlugins(
		providersDir(),
		native.map((p) => p.name),
		createJiti(import.meta.url),
	);
	for (const w of warnings) console.warn(w);

	// Fail fast on unknown SEARCH_PROVIDERS entries (startup error).
	const chain = resolveChain([...native, ...plugins], parseProviderList(process.env.SEARCH_PROVIDERS));

	// ── Tool: web_search ──
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: [
			"Search the web for information. Supports single query or batch queries (parallel).",
			"Returns ranked results with title, URL, snippet, and relevance score.",
			"Uses the configured search providers (default: Tavily, then Brave).",
		].join(" "),
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query" })),
			queries: Type.Optional(
				Type.Array(Type.String(), {
					description: "Multiple queries to search in parallel (max 5)",
					maxItems: 5,
				})
			),
			max_results: Type.Optional(
				Type.Number({ description: "Max results per query (default: 5, max: 10)", default: 5, maximum: 10 })
			),
			search_depth: Type.Optional(
				Type.String({
					description: '"basic" for speed, "advanced" for thoroughness (Tavily only)',
					default: "basic",
				})
			),
			include_domains: Type.Optional(
				Type.Array(Type.String(), { description: "Only include results from these domains" })
			),
			exclude_domains: Type.Optional(
				Type.Array(Type.String(), { description: "Exclude results from these domains" })
			),
		}),

		async execute(_toolCallId, params) {
			const maxResults = Math.min(params.max_results ?? 5, 10);
			const searchDepth = params.search_depth === "advanced" ? "advanced" : "basic";
			const opts = {
				maxResults,
				searchDepth,
				includeDomains: params.include_domains,
				excludeDomains: params.exclude_domains,
			};

			// Batch mode
			if (params.queries && params.queries.length > 0) {
				const { results, providers: used, failures } = await chainBatchSearch(chain, params.queries, opts);
				const totalResults = Object.values(results).reduce((s, r) => s + r.length, 0);
				const via = used.length ? used.join(", ") : "no provider";
				let text = `Searched ${params.queries.length} queries via ${via}, found ${totalResults} results:\n\n`;

				for (const [query, hits] of Object.entries(results)) {
					const failed = failures[query];
					text += `### "${query}" (${hits.length} results)${failed ? " — ⚠️ all providers failed" : ""}\n\n`;
					if (failed) text += `_${failed}_\n\n`;
					for (let i = 0; i < hits.length; i++) {
						const h = hits[i];
						text += `${i + 1}. **${h.title}**\n   ${h.url}\n   ${h.snippet}\n`;
						if (h.score) text += `   Relevance: ${(h.score * 100).toFixed(0)}%`;
						if (h.publishedDate) text += ` | Date: ${h.publishedDate}`;
						text += "\n\n";
					}
				}
				return { content: [{ type: "text", text }] };
			}

			// Single mode
			if (!params.query) {
				return {
					content: [{ type: "text", text: "Error: provide either `query` (string) or `queries` (array)." }],
					isError: true,
				};
			}

			const { provider, results } = await chainSearch(chain, params.query, opts);

			let text = `Searched "${params.query}" via ${provider}, found ${results.length} results:\n\n`;
			for (let i = 0; i < results.length; i++) {
				const r = results[i];
				text += `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}\n`;
				if (r.score) text += `   Relevance: ${(r.score * 100).toFixed(0)}%`;
				if (r.publishedDate) text += ` | Date: ${r.publishedDate}`;
				text += "\n\n";
			}
			return { content: [{ type: "text", text }] };
		},
	});

	// ── Tool: web_extract ──
	pi.registerTool({
		name: "web_extract",
		label: "Web Extract",
		description: [
			"Extract the main text content from a web page URL.",
			"Strips HTML, scripts, navigation, and returns clean text.",
			"Uses the first configured provider with extraction capability, otherwise a basic HTTP fetch.",
			"Use after web_search to read full content of promising results.",
		].join(" "),
		parameters: Type.Object({
			url: Type.String({ description: "URL of the web page to extract content from" }),
		}),

		async execute(_toolCallId, params) {
			try {
				const result = await chainExtract(chain, params.url);
				let text = `# ${result.title}\n\n`;
				text += `**URL:** ${result.url}\n`;
				text += `**Provider:** ${result.provider}\n`;
				if (result.author) text += `**Author:** ${result.author}\n`;
				if (result.publishedDate) text += `**Published:** ${result.publishedDate}\n`;
				text += `**Word count:** ${result.wordCount}\n\n---\n\n`;
				text += result.content;
				return { content: [{ type: "text", text }] };
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				return {
					content: [{ type: "text", text: `Failed to extract content from ${params.url}: ${msg}` }],
					isError: true,
				};
			}
		},
	});

	// ── Tool: research_checkpoint ──
	// Hard gate: LLM must call this after each search round.
	// Code decides whether to continue searching or allow synthesis.
	// (Ported unchanged from v0.1.6 — do not modify.)

	const DEPTH_THRESHOLDS: Record<
		string,
		{
			minSearchRounds: number;
			maxSearchRounds: number;
			minSources: number;
			confidenceThreshold: number;
			minAnsweredRatio: number;
		}
	> = {
		quick: { minSearchRounds: 1, maxSearchRounds: 3, minSources: 3, confidenceThreshold: 60, minAnsweredRatio: 0.6 },
		standard: { minSearchRounds: 2, maxSearchRounds: 6, minSources: 5, confidenceThreshold: 75, minAnsweredRatio: 0.7 },
		deep: { minSearchRounds: 3, maxSearchRounds: 10, minSources: 10, confidenceThreshold: 85, minAnsweredRatio: 0.8 },
		exhaustive: { minSearchRounds: 5, maxSearchRounds: 20, minSources: 15, confidenceThreshold: 95, minAnsweredRatio: 0.9 },
	};

	pi.registerTool({
		name: "research_checkpoint",
		label: "Research Checkpoint",
		description: [
			"MANDATORY after each search round during deep research.",
			"Submit current research state for evaluation.",
			"The tool will analyze your progress and return a VERDICT: CONTINUE (must search more) or PROCEED (may synthesize report).",
			"You MUST obey the verdict — if it says CONTINUE, you must do another search round before calling this again.",
			"Do NOT skip this tool or write the report without a PROCEED verdict.",
		].join(" "),
		parameters: Type.Object({
			depth: Type.String({
				description: 'Research depth level: "quick", "standard", "deep", or "exhaustive"',
			}),
			round: Type.Number({
				description: "Current search round number (1-indexed, increment after each search batch)",
			}),
			sub_questions: Type.Array(
				Type.Object({
					question: Type.String({ description: "The sub-question" }),
					answered: Type.Boolean({ description: "Whether this sub-question has been adequately answered" }),
					confidence: Type.Number({ description: "Confidence score 0-100 for this sub-question" }),
					source_count: Type.Number({ description: "Number of sources found for this sub-question" }),
					best_source_tier: Type.Number({ description: "Best source credibility tier (1=authoritative, 2=reliable, 3=community, 4=unverified)" }),
				}),
				{ description: "Status of each sub-question" }
			),
			total_sources: Type.Number({ description: "Total unique sources collected so far" }),
			contradictions: Type.Optional(
				Type.Array(Type.String(), { description: "List of contradictions found between sources" })
			),
			gaps: Type.Optional(
				Type.Array(Type.String(), { description: "Known information gaps that remain" })
			),
		}),

		async execute(_toolCallId, params) {
			const thresholds = DEPTH_THRESHOLDS[params.depth] ?? DEPTH_THRESHOLDS.standard;
			const totalQuestions = params.sub_questions.length;
			const answeredCount = params.sub_questions.filter((q) => q.answered).length;
			const answeredRatio = totalQuestions > 0 ? answeredCount / totalQuestions : 0;
			const avgConfidence =
				totalQuestions > 0 ? params.sub_questions.reduce((sum, q) => sum + q.confidence, 0) / totalQuestions : 0;
			const minConfidence =
				totalQuestions > 0 ? Math.min(...params.sub_questions.map((q) => q.confidence)) : 0;
			const hasContradictions = (params.contradictions?.length ?? 0) > 0;
			const lowConfidenceQuestions = params.sub_questions.filter((q) => q.confidence < 40);
			const medConfidenceQuestions = params.sub_questions.filter(
				(q) => q.confidence >= 40 && q.confidence < thresholds.confidenceThreshold
			);

			// ── Evaluate ──
			const issues: string[] = [];
			let verdict: "CONTINUE" | "PROCEED" = "PROCEED";

			// Rule 1: Haven't done minimum search rounds
			if (params.round < thresholds.minSearchRounds) {
				verdict = "CONTINUE";
				issues.push(`⛔ Min search rounds not met: ${params.round}/${thresholds.minSearchRounds} rounds`);
			}

			// Rule 2: Not enough sources
			if (params.total_sources < thresholds.minSources) {
				verdict = "CONTINUE";
				issues.push(`⛔ Not enough sources: ${params.total_sources}/${thresholds.minSources} sources`);
			}

			// Rule 3: Too many unanswered questions
			if (answeredRatio < thresholds.minAnsweredRatio) {
				verdict = "CONTINUE";
				issues.push(
					`⛔ Answered ratio too low: ${answeredCount}/${totalQuestions} (${(answeredRatio * 100).toFixed(0)}% < ${(thresholds.minAnsweredRatio * 100).toFixed(0)}%)`
				);
			}

			// Rule 4: Average confidence below threshold
			if (avgConfidence < thresholds.confidenceThreshold) {
				verdict = "CONTINUE";
				issues.push(`⛔ Average confidence too low: ${avgConfidence.toFixed(0)}% < ${thresholds.confidenceThreshold}%`);
			}

			// Rule 5: Any question with very low confidence
			if (lowConfidenceQuestions.length > 0 && params.round < thresholds.maxSearchRounds) {
				verdict = "CONTINUE";
				const names = lowConfidenceQuestions.map((q) => `"${q.question}" (${q.confidence}%)`).join(", ");
				issues.push(`⛔ Low-confidence sub-questions (<40%): ${names}`);
			}

			// Rule 6: Unresolved contradictions
			if (hasContradictions && params.round < thresholds.maxSearchRounds) {
				verdict = "CONTINUE";
				issues.push(
					`⚠️ Unresolved contradictions (${params.contradictions!.length}) — search for authoritative sources to verify`
				);
			}

			// Safety valve: don't exceed max rounds
			if (params.round >= thresholds.maxSearchRounds) {
				verdict = "PROCEED";
				if (issues.length > 0) {
					issues.push(
						`⚠️ Max search rounds reached (${thresholds.maxSearchRounds}). Proceeding to report. Remaining issues will be noted in "Uncertainties & Gaps".`
					);
				}
			}

			// ── Build response ──
			const statusBar = `${"█".repeat(Math.round(avgConfidence / 5))}${"░".repeat(20 - Math.round(avgConfidence / 5))}`;

			let text = `## Research Checkpoint — Round ${params.round}\n\n`;
			text += `**Depth:** ${params.depth} | **Verdict: ${verdict === "CONTINUE" ? "🔴 CONTINUE SEARCHING" : "🟢 PROCEED TO REPORT"}**\n\n`;
			text += `### Progress\n`;
			text += `- Search rounds: ${params.round} / ${thresholds.minSearchRounds}-${thresholds.maxSearchRounds}\n`;
			text += `- Sources collected: ${params.total_sources} / ${thresholds.minSources} (minimum)\n`;
			text += `- Sub-questions answered: ${answeredCount}/${totalQuestions} (${(answeredRatio * 100).toFixed(0)}%)\n`;
			text += `- Avg confidence: ${statusBar} ${avgConfidence.toFixed(0)}% (threshold: ${thresholds.confidenceThreshold}%)\n`;
			text += `- Min confidence: ${minConfidence.toFixed(0)}%\n`;

			text += `\n### Sub-question Status\n`;
			for (const q of params.sub_questions) {
				const icon =
					q.confidence >= thresholds.confidenceThreshold ? "✅" : q.confidence >= 40 ? "🟡" : "🔴";
				text += `${icon} [${q.confidence}%] ${q.question} — ${q.source_count} sources (Tier ${q.best_source_tier})\n`;
			}

			if (issues.length > 0) {
				text += `\n### Issues\n`;
				for (const issue of issues) {
					text += `${issue}\n`;
				}
			}

			if (params.contradictions && params.contradictions.length > 0) {
				text += `\n### Contradictions\n`;
				for (const c of params.contradictions) {
					text += `- ⚡ ${c}\n`;
				}
			}

			if (params.gaps && params.gaps.length > 0) {
				text += `\n### Remaining Gaps\n`;
				for (const g of params.gaps) {
					text += `- ❓ ${g}\n`;
				}
			}

			if (verdict === "CONTINUE") {
				text += `\n### 📋 Next Actions Required\n`;
				text += `You MUST perform another search round addressing the issues above, then call \`research_checkpoint\` again.\n`;

				// Specific guidance
				if (lowConfidenceQuestions.length > 0) {
					text += `\n**Priority — Low confidence questions to focus on:**\n`;
					for (const q of lowConfidenceQuestions) {
						text += `- "${q.question}" — try different search queries, different angles\n`;
					}
				}
				if (medConfidenceQuestions.length > 0) {
					text += `\n**Secondary — Medium confidence questions to strengthen:**\n`;
					for (const q of medConfidenceQuestions) {
						text += `- "${q.question}" (${q.confidence}%) — find corroborating sources\n`;
					}
				}
				if (hasContradictions) {
					text += `\n**Resolve contradictions** by searching for authoritative (Tier 1) sources.\n`;
				}
			} else {
				text += `\n### ✅ Ready to Synthesize\n`;
				text += `All criteria met. Proceed to Phase 4 — write the research report.\n`;
				if (params.gaps && params.gaps.length > 0) {
					text += `Include the ${params.gaps.length} remaining gap(s) in the "Uncertainties & Gaps" section of the report.\n`;
				}
				if (hasContradictions) {
					text += `Include the ${params.contradictions!.length} contradiction(s) in the report — present both sides.\n`;
				}
			}

			return { content: [{ type: "text", text }] };
		},
	});
}
```

- [x] **Step 2: Verify the suite still passes and review deltas**

Run: `npm test`
Expected: PASS (entry isn't unit-tested; suite guards the modules it consumes).

Review checklist (diff against the pre-rewrite `extension.ts`):
- Header comment no longer claims a "bash curl fallback" (v0.1.6 header lied — spec requires dropping that claim).
- Tool schemas byte-identical to v0.1.6 (only the two description strings changed, per spec).
- `research_checkpoint` body identical to v0.1.6 lines 309–499.
- Happy-path single-search output format identical (`Searched "q" via <provider>, found N results:` …).

- [x] **Step 3: Commit**

```bash
git add extension.ts
git commit -m "feat: rewrite extension.ts as thin entry over the provider chain (async factory, plugin registry, fail-fast config)"
```

---

### Task 7: Example plugins + docs + release metadata

**Files:**
- Create: `examples/providers/firecrawl.ts`
- Create: `examples/providers/searxng.ts`
- Create: `examples/README.md`
- Modify: `README.md` (Configuration section + Package Contents table)
- Modify: `CHANGELOG.md` (0.3.0 entry at top)
- Modify: `package.json` (`version: 0.3.0`)

**Interfaces:**
- Consumes: the plugin file format from Tasks 1/5 (default export conforming to `SearchProvider`, standalone — examples may NOT import from the package since they are copied to `~/.pi/agent/deep-research/providers/` where package imports don't resolve).
- Produces: copy-paste starting points (ported from PR #4 by @fank, credit in file headers), docs, 0.3.0.

- [x] **Step 1: Write `examples/providers/searxng.ts`**

```ts
/**
 * Example search provider plugin: SearXNG (local metasearch).
 * Ported from PR #4 by @fank.
 *
 * Install:
 *   1. cp searxng.ts ~/.pi/agent/deep-research/providers/
 *   2. export SEARXNG_BASE_URL=http://localhost:4000
 *   3. export SEARCH_PROVIDERS=searxng            (or e.g. "searxng,tavily")
 *   4. /reload
 *
 * GOTCHA: SearXNG's JSON API is DISABLED BY DEFAULT (returns 403).
 * In your searxng/settings.yml you must enable:
 *   search:
 *     formats:
 *       - html
 *       - json
 */

export default {
	name: "searxng",
	tier: "local" as const,
	isConfigured: () => Boolean(process.env.SEARXNG_BASE_URL),
	async search(req: { query: string; maxResults: number; signal?: AbortSignal }) {
		const baseUrl = process.env.SEARXNG_BASE_URL!.replace(/\/+$/, "");
		const params = new URLSearchParams({
			q: req.query,
			format: "json",
			language: "en",
			categories: "general",
		});
		const resp = await fetch(`${baseUrl}/search?${params}`, {
			signal: req.signal ?? AbortSignal.timeout(30000),
		});

		if (!resp.ok) {
			const text = await resp.text();
			throw new Error(`SearXNG search error ${resp.status}: ${text}`);
		}

		const data = (await resp.json()) as {
			results: Array<{ title: string; url: string; content: string; publishedDate?: string }>;
		};

		return (data.results ?? []).slice(0, req.maxResults).map((r) => ({
			title: r.title ?? "",
			url: r.url ?? "",
			snippet: r.content ?? "",
			publishedDate: r.publishedDate,
		}));
	},
};
```

- [x] **Step 2: Write `examples/providers/firecrawl.ts`**

```ts
/**
 * Example search provider plugin: self-hosted Firecrawl (local search + JS-rendered extraction).
 * Ported from PR #4 by @fank.
 *
 * Install:
 *   1. cp firecrawl.ts ~/.pi/agent/deep-research/providers/
 *   2. export FIRECRAWL_BASE_URL=http://localhost:3002   (your Firecrawl instance)
 *      export FIRECRAWL_BASIC_AUTH=user:pass              (only if behind a reverse proxy)
 *   3. export SEARCH_PROVIDERS=firecrawl                  (or e.g. "firecrawl,tavily")
 *   4. /reload
 *
 * extract() uses /v1/scrape (Playwright-rendered → Markdown); a 200 with
 * blank markdown is treated as failure so the chain can fall back.
 */

export default {
	name: "firecrawl",
	tier: "local" as const,
	isConfigured: () => Boolean(process.env.FIRECRAWL_BASE_URL),
	async search(req: { query: string; maxResults: number; signal?: AbortSignal }) {
		const baseUrl = process.env.FIRECRAWL_BASE_URL!.replace(/\/+$/, "");
		const resp = await fetch(`${baseUrl}/v1/search`, {
			method: "POST",
			headers: firecrawlHeaders(),
			body: JSON.stringify({
				query: req.query,
				limit: req.maxResults,
				scrapeOptions: { formats: [] }, // just search, don't scrape each result
			}),
			signal: req.signal ?? AbortSignal.timeout(30000),
		});

		if (!resp.ok) {
			const text = await resp.text();
			throw new Error(`Firecrawl search error ${resp.status}: ${text}`);
		}

		const data = (await resp.json()) as {
			success: boolean;
			data: Array<{ title?: string; url?: string; description?: string }>;
		};

		return (data.data ?? []).slice(0, req.maxResults).map((d) => ({
			title: d.title ?? "",
			url: d.url ?? "",
			snippet: d.description ?? "",
		}));
	},
	async extract(url: string, signal?: AbortSignal) {
		const baseUrl = process.env.FIRECRAWL_BASE_URL!.replace(/\/+$/, "");
		const resp = await fetch(`${baseUrl}/v1/scrape`, {
			method: "POST",
			headers: firecrawlHeaders(),
			body: JSON.stringify({ url, formats: ["markdown"] }),
			signal: signal ?? AbortSignal.timeout(30000),
		});

		if (!resp.ok) {
			const text = await resp.text();
			throw new Error(`Firecrawl scrape error ${resp.status}: ${text}`);
		}

		const data = (await resp.json()) as {
			success?: boolean;
			error?: string;
			data?: {
				title?: string;
				url?: string;
				markdown?: string;
				// Firecrawl passes most raw meta keys straight through — read
				// author/date via candidate keys, not fixed fields.
				metadata?: { title?: string; sourceURL?: string; [key: string]: unknown };
			};
		};

		if (data.success === false) throw new Error(`Firecrawl scrape unsuccessful: ${data.error ?? "unknown error"}`);

		const doc = data.data;
		if (!doc) throw new Error("Firecrawl returned empty document");

		const rawContent = doc.markdown ?? "";
		// A 200 with empty markdown (JS-heavy or blocked page) is not a usable
		// extract — throw so the chain falls back to another extractor.
		if (!rawContent.trim()) throw new Error("Firecrawl returned no content (page may require JS or be blocked)");

		const title = doc.metadata?.title ?? doc.title ?? "";
		const author = pickMeta(doc.metadata, ["author", "article:author", "dc.creator", "parsely-author"]);
		const publishedDate = pickMeta(doc.metadata, ["publishedTime", "article:published_time", "date"]);
		const { content, wordCount } = truncateToWords(rawContent);

		return { title, url, content, author, publishedDate, wordCount, provider: "firecrawl" };
	},
};

function firecrawlHeaders(): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	const basicAuth = process.env.FIRECRAWL_BASIC_AUTH; // "user:password" — never logged
	if (basicAuth) headers["Authorization"] = "Basic " + Buffer.from(basicAuth).toString("base64");
	return headers;
}

function truncateToWords(content: string): { content: string; wordCount: number } {
	const MAX_WORDS = 8000;
	const re = /\S+/g;
	let count = 0;
	let cutIdx = -1;
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null) {
		count++;
		if (count === MAX_WORDS) cutIdx = m.index + m[0].length;
	}
	if (count <= MAX_WORDS) return { content, wordCount: count };
	return { content: content.slice(0, cutIdx) + `\n\n[... truncated, total ${count} words]`, wordCount: count };
}

function pickMeta(meta: Record<string, unknown> | undefined, keys: string[]): string | undefined {
	if (!meta) return undefined;
	for (const k of keys) {
		const v = meta[k];
		if (typeof v === "string" && v.trim()) return v;
		if (Array.isArray(v) && typeof v[0] === "string" && v[0].trim()) return v[0];
	}
	return undefined;
}
```

- [x] **Step 3: Write `examples/README.md`**

```md
# Example Provider Plugins

Copy-paste starting points for custom search providers. These are NOT
installed or loaded by default — copying a file into the plugin directory is
an explicit opt-in.

## Install a plugin

1. Copy the file into the plugin directory (create it if needed):

   ```bash
   mkdir -p ~/.pi/agent/deep-research/providers
   cp examples/providers/searxng.ts ~/.pi/agent/deep-research/providers/
   ```

2. Set whatever environment variables the plugin needs (see its header
   comment), e.g. `SEARXNG_BASE_URL=http://localhost:4000`.

3. List it in the chain:

   ```bash
   export SEARCH_PROVIDERS=searxng              # local only — cloud never contacted
   # or, local first with cloud fallback:
   export SEARCH_PROVIDERS=firecrawl,searxng,tavily,brave
   ```

4. Run `/reload` in pi (or restart). The plugin directory is re-scanned on
   every extension load — that is the hot-plug mechanism. There is no
   mid-session file watching.

Remove a plugin from the chain by removing it from `SEARCH_PROVIDERS` (the
file can stay); delete the file to remove it entirely.

## Write your own

A plugin is a single `.ts` file whose default export conforms to the
SearchProvider contract:

```ts
export default {
	name: "my-engine",            // required: lowercase [a-z0-9-], unique; "tavily"/"brave" are reserved
	tier: "local",                // "local" | "cloud" — display metadata only
	isConfigured: () => Boolean(process.env.MY_ENGINE_URL),  // false → skipped, recorded in attempts
	async search(req) {           // required: return [] on success-with-zero-hits; throw on failure
		// req: { query, maxResults, searchDepth?, signal? } — honor signal if you can
		return [{ title, url, snippet, score?, publishedDate? }];
	},
	// optional: extraction capability for web_extract
	async extract(url, signal) {
		return { title, url, content, wordCount, provider: "my-engine" };
	},
};
```

Chain semantics are uniform for every provider: not configured → skipped;
≥1 result after domain filtering → wins; empty → next provider; error → next
provider; all exhausted → aggregated error listing every attempt.

## Security notes

- Plugin code runs with your full user privileges — same trust level as
  `~/.pi/agent/extensions/`. Only install plugins you have read and trust.
- The plugin directory is global (`~/.pi/agent/deep-research/providers/`).
  Project-level directories are deliberately not loaded — they would bypass
  pi's project trust gate.
```

- [x] **Step 4: Update `README.md`**

Replace the "### Search Providers" subsection (lines ~190–197) with:

```md
### Search Providers

Built-in (no setup beyond an API key):

| Provider | Env Variable | Free Tier |
|----------|-------------|-----------|
| [Tavily](https://tavily.com) (default first) | `TAVILY_API_KEY` | 1000 req/month |
| [Brave Search](https://brave.com/search/api/) | `BRAVE_API_KEY` | 2000 req/month |

**Provider chain.** `SEARCH_PROVIDERS` is a comma-separated, ordered list of
the providers to try (default `tavily,brave`). Each provider is tried in
order until one returns results; empty results and errors both fall through
to the next provider. Providers with no credentials configured are skipped.

```bash
export SEARCH_PROVIDERS=tavily,brave        # default
export SEARCH_PROVIDERS=firecrawl,tavily   # custom plugin first
```

**Custom providers (hot-pluggable).** Any search engine — including local
ones like [SearXNG](https://docs.searxng.org) or self-hosted
[Firecrawl](https://firecrawl.dev) — can be added by dropping a `.ts` plugin
into `~/.pi/agent/deep-research/providers/`, listing it in
`SEARCH_PROVIDERS`, and running `/reload`. Ready-made examples and the plugin
contract: [`examples/`](examples/README.md). Listing only local providers
gives you a fully air-gapped setup — cloud APIs are never in the chain.

If no provider is configured at all, `web_search` returns an error explaining
what to set.
```

And in the "Package Contents" table, after the `extension.ts` row, add:

```md
| `src/` | Provider chain engine, plugin loader, native Tavily/Brave providers |
| `examples/` | Example provider plugins (SearXNG, Firecrawl) + plugin authoring guide |
```

- [x] **Step 5: Update `CHANGELOG.md`** (new entry directly under `# Changelog`)

```md
## [0.3.0] - 2026-08-25

### Added
- Hot-pluggable search providers: drop a `.ts` plugin into `~/.pi/agent/deep-research/providers/`, list it in `SEARCH_PROVIDERS`, `/reload` — no pi extension API knowledge required.
- `SEARCH_PROVIDERS` env var: ordered provider chain defining both set and order (default `tavily,brave`; blank = default). Listing only local providers yields a fully air-gapped setup.
- Example plugins (not active by default): `examples/providers/searxng.ts`, `examples/providers/firecrawl.ts` — ported from #4 by @fank.
- Offline unit test suite (`npm test`, node:test, zero new dev dependencies).

### Changed
- Empty search results now fall through to the next provider instead of returning zero results immediately.
- When a key IS set but every provider fails, `web_search` reports an aggregated per-provider error (`Attempts: tavily → error (…), brave → empty`) instead of the misleading "No search API configured".
- Provider calls time out after 30s and fail over instead of hanging.
- `web_extract` output includes a `**Provider:**` line naming the extractor that ran; providers with extraction capability (e.g. Firecrawl) are used before the basic HTTP fetch.
- Batch search surfaces per-query failures instead of silently returning empty arrays.
- Content truncation preserves markdown/newlines up to the cut instead of flattening whitespace.
- `include_domains`/`exclude_domains` are applied client-side across all providers, with subdomain-aware matching.

### Internal
- `extension.ts` split into `src/` (config, chain engine, plugin loader, native providers). The chain engine is a pure function over injectable providers — the full empty/error/ordering matrix is unit-tested offline.
```

- [x] **Step 6: Bump version + verify**

`package.json`: `"version": "0.1.6"` → `"version": "0.3.0"`.

Run: `npm test`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add examples README.md CHANGELOG.md package.json
git commit -m "docs+feat: example plugins (searxng, firecrawl from #4), custom-provider docs, 0.3.0 changelog"
```

---

### Task 8: Final verification (spec success criteria audit)

**Files:** none created; produces verification evidence.

- [x] **Step 1: Full offline test run**

Run: `npm test`
Expected: PASS, zero network access (all fetch injected/mocked). Capture the summary line.

- [x] **Step 2: Packaging check**

Run: `npm pack --dry-run 2>&1 | grep -E "src/|examples/|extension.ts"`
Expected: lists `src/**`, `examples/**`, `extension.ts` among packed files.

- [x] **Step 3: Hot-plug simulation (offline, no pi needed)**

Run a one-off script (do not commit it) that exercises the real loader + config + chain with a stub plugin in a temp HOME:

```bash
tmp=$(mktemp -d)
mkdir -p "$tmp/.pi/agent/deep-research/providers"
cat > "$tmp/.pi/agent/deep-research/providers/stub.ts" <<'EOF'
export default {
	name: "stub",
	tier: "local",
	isConfigured: () => true,
	search: async () => [{ title: "stub hit", url: "https://stub.example/x", snippet: "from plugin" }],
};
EOF
node --input-type=module -e "
import { createJiti } from 'jiti';
import { loadPlugins, providersDir } from './src/loader.ts';
import { parseProviderList, resolveChain } from './src/config.ts';
import { chainSearch } from './src/chain.ts';
import { createTavilyProvider, createBraveProvider } from './src/native/index.ts';

const home = process.argv[2];
delete process.env.TAVILY_API_KEY; delete process.env.BRAVE_API_KEY;
const native = [createTavilyProvider(), createBraveProvider()];
const { providers, warnings } = await loadPlugins(providersDir(home), native.map(p => p.name), createJiti(import.meta.url));
console.log('warnings:', warnings);
const chain = resolveChain([...native, ...providers], parseProviderList('stub,tavily,brave'));
const r = await chainSearch(chain, 'any', { maxResults: 5 });
console.log('winning provider:', r.provider, '| results:', r.results.length);

// negative: unknown name fails fast
try { resolveChain([...native, ...providers], parseProviderList('typo,stub')); }
catch (e) { console.log('validation error:', e.message.split('\n')[0]); }
" "$tmp"
```

Expected output: `warnings: []`, `winning provider: stub | results: 1`, and a validation error naming `typo` + available providers (`brave, stub, tavily`). Cleanup: `rm -rf "$tmp"`.

- [x] **Step 4: pi-runtime smoke (best effort — depends on pi + API key availability)**

Check `command -v pi` and `echo ${TAVILY_API_KEY:+set}`:
- If pi and a key are available: run a minimal non-interactive probe, e.g.
  `pi -p 'call web_search with query "pi coding agent github" max_results 3'` (or the session equivalent that exercises the tool), and verify output format matches v0.1.6: `Searched "…" via tavily, found N results:`.
- If NOT available: record "pi-runtime smoke not executed (no pi / no key in this environment)" in the final report and leave criteria 3–4 of the spec's Success Criteria as pending user verification. Do NOT claim them as verified.

- [x] **Step 5: Spec coverage audit + final commit**

Re-read `docs/superpowers/specs/2026-08-25-provider-plugin-foundation-design.md` §Goals, §Chain Semantics, §Packaging, §Success Criteria and check every bullet against shipped code/tests. Record any gap honestly in the final report (do not silently skip). If the plan document has unchecked boxes left over, tick them off.

```bash
git add -A && git commit -m "test: final verification for provider plugin foundation (allow-empty if nothing changed)" --allow-empty
```

---

## Self-Review (done at planning time)

- **Spec coverage:** Goals 1–6 → Tasks 1–7 (compat: Task 4/6; hot-plug: Task 5/6; chain semantics: Task 3; air-gap: Task 2 `SEARCH_PROVIDERS`; testable core: Tasks 1–5; small core: Task 6 thin entry). Non-Goals honored (no project dir, no event bus, no npm plugin distribution, no per-provider timeouts, examples not active). Packaging → Task 1+7. Success criteria → Task 8. PR #4 closure (comment on the PR) is a maintainer action **outside this repo's code** — flagged in the final report, not a plan task.
- **Placeholders:** none — every step carries complete code/commands/expected output.
- **Type consistency:** `SearchRequest{query,maxResults,searchDepth?,signal?}` used identically in chain/native/examples; `extract?(url, signal?)` consistent across types/chain/examples; `chainSearch`/`chainBatchSearch`/`chainExtract` signatures match between Task 3 (definition) and Task 6 (use).
```
