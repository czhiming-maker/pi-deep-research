/**
 * Example search provider plugin: self-hosted Firecrawl (local search + JS-rendered extraction).
 * Ported from PR #4 by @fank.
 *
 * Install:
 *   1. cp firecrawl.ts ~/.pi/agent/pi-deep-research/providers/
 *   2. export FIRECRAWL_BASE_URL=http://localhost:3002   (your Firecrawl instance)
 *      export FIRECRAWL_BASIC_AUTH=user:pass              (only if behind a reverse proxy)
 *   3. list "firecrawl" in ~/.pi/agent/pi-deep-research/config.json (or SEARCH_PROVIDERS=firecrawl)
 *   4. /reload
 *
 * extract() uses /v1/scrape (Playwright-rendered → Markdown); a 200 with
 * blank markdown is treated as failure so the chain can fall back.
 */

// Self-contained type shims: keep this file editor-clean when copied to
// ~/.pi/agent/pi-deep-research/providers/, where no @types/node exists.
declare const process: { env: Record<string, string | undefined> };

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
	if (basicAuth) headers["Authorization"] = "Basic " + btoa(basicAuth); // ASCII credentials
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
