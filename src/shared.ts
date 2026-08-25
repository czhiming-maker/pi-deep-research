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
