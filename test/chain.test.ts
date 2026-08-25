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
	title: "T",
	url: "https://x",
	content,
	wordCount: content.split(/\s+/).filter(Boolean).length,
	provider: "stub",
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
		const a = provider({
			name: "a",
			search: async () => {
				throw new Error("401 Unauthorized");
			},
		});
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
		const a = provider({
			name: "a",
			search: async () => [hit("https://keep.com/1"), hit("https://drop.net/2")],
		});
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
		const a = provider({ name: "a", search: () => new Promise<SearchResult[]>(() => {}) }); // never settles
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
		const a = provider({
			name: "a",
			extract: async () => {
				throw new Error("boom");
			},
		});
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
		// <title> text survives the regex strip — faithful to the v0.1.6 extractor
		assert.equal(r.content, "Page hello world");
	});
});

describe("chainBatchSearch", () => {
	it("runs queries in parallel, collects providers used and per-query failures", async () => {
		const ok = provider({
			name: "ok",
			search: async (req) => (req.query === "good" ? [hit("https://ok")] : []),
		});
		const empty = provider({ name: "e", search: async () => [] });
		const out = await chainBatchSearch([ok, empty], ["good", "bad"], { maxResults: 5 });
		assert.deepEqual(out.results["good"].map((r) => r.url), ["https://ok"]);
		assert.deepEqual(out.results["bad"], []);
		assert.deepEqual(out.providers, ["ok"]);
		assert.match(out.failures["bad"], /No search provider produced results/);
	});
});
