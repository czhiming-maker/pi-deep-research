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
