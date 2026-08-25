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
		assert.deepEqual(r, [
			{ title: "T", url: "https://x", snippet: "snippet text", score: 0.87, publishedDate: "2026-01-02" },
		]);
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
