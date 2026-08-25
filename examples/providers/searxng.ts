/**
 * Example search provider plugin: SearXNG (local metasearch).
 * Ported from PR #4 by @fank.
 *
 * Install:
 *   1. cp searxng.ts ~/.pi/agent/pi-deep-research/providers/
 *   2. export SEARXNG_BASE_URL=http://localhost:4000
 *   3. list "searxng" in ~/.pi/agent/pi-deep-research/config.json (or SEARCH_PROVIDERS=searxng)
 *   4. /reload
 *
 * GOTCHA: SearXNG's JSON API is DISABLED BY DEFAULT (returns 403).
 * In your searxng/settings.yml you must enable:
 *   search:
 *     formats:
 *       - html
 *       - json
 */

// Self-contained type shims: keep this file editor-clean when copied to
// ~/.pi/agent/pi-deep-research/providers/, where no @types/node exists.
declare const process: { env: Record<string, string | undefined> };

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
