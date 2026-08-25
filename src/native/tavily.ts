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
