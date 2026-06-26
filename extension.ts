/**
 * Deep Research Extension — web_search + web_extract tools
 *
 * Provides LLM-callable tools for internet search and content extraction.
 * Supports multiple providers with local-first priority:
 *
 *   1. Firecrawl (local)     — FIRECRAWL_BASE_URL=http://localhost:3002
 *   2. SearXNG (local)       — SEARXNG_BASE_URL=http://localhost:4000
 *   3. Tavily (cloud)        — TAVILY_API_KEY=tvly-...
 *   4. Brave Search (cloud)  — BRAVE_API_KEY=BSA...
 *
 * Firecrawl is a full web scraping/crawling stack that can run completely
 * offline via Docker Compose. SearXNG is a lightweight metasearch engine
 * that also runs in a single container. When both local providers are active
 * and the container is configured with no external network, this yields a
 * fully isolated local research environment.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ─── Types ───

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	score?: number;
	publishedDate?: string;
}

interface ExtractResult {
	title: string;
	url: string;
	content: string;
	author?: string;
	publishedDate?: string;
	wordCount: number;
	provider: string; // extractor that actually produced this — may differ from configured (fallback)
}

// ─── Configuration ───

const FIRECRAWL_BASE_URL   = process.env.FIRECRAWL_BASE_URL;     // e.g. http://localhost:3002
const FIRECRAWL_BASIC_AUTH = process.env.FIRECRAWL_BASIC_AUTH;   // "user:password" when Firecrawl is behind HTTP Basic Auth
const SEARXNG_BASE_URL     = process.env.SEARXNG_BASE_URL;       // e.g. http://localhost:4000
const TAVILY_API_KEY       = process.env.TAVILY_API_KEY;
const BRAVE_API_KEY        = process.env.BRAVE_API_KEY;

/** Build headers for Firecrawl API calls, optionally with HTTP Basic auth. */
function firecrawlHeaders(): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (FIRECRAWL_BASIC_AUTH) {
		headers["Authorization"] = "Basic " + Buffer.from(FIRECRAWL_BASIC_AUTH).toString("base64");
	}
	return headers;
}

const MAX_WORDS = 8000;

// ─── Helpers ───

/** Truncate to MAX_WORDS, preserving the original text (incl. markdown/newlines) up to the cut. */
function truncateToWords(content: string): { content: string; wordCount: number } {
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

function hostMatches(host: string, domain: string): boolean {
	const h = host.toLowerCase();
	const d = domain.toLowerCase().replace(/^\.+/, "");
	return h === d || h.endsWith("." + d);
}

/** Filter results by include/exclude domains client-side, so every provider honors the filter uniformly. */
function applyDomainFilter(results: SearchResult[], include?: string[], exclude?: string[]): SearchResult[] {
	if (!include?.length && !exclude?.length) return results;
	return results.filter((r) => {
		let host: string | null = null;
		try { host = new URL(r.url).hostname; } catch { /* unparseable URL */ }
		if (include?.length && !(host && include.some((d) => hostMatches(host!, d)))) return false;
		if (exclude?.length && host && exclude.some((d) => hostMatches(host!, d))) return false;
		return true;
	});
}

/** First non-empty metadata value across candidate keys (Firecrawl passes raw meta keys straight through). */
function pickMeta(meta: Record<string, unknown> | undefined, keys: string[]): string | undefined {
	if (!meta) return undefined;
	for (const k of keys) {
		const v = meta[k];
		if (typeof v === "string" && v.trim()) return v;
		if (Array.isArray(v) && typeof v[0] === "string" && v[0].trim()) return v[0];
	}
	return undefined;
}

// ─── Search Providers ───

async function searchFirecrawl(query: string, maxResults: number): Promise<SearchResult[]> {
	const baseUrl = FIRECRAWL_BASE_URL!.replace(/\/+$/, "");
	const resp = await fetch(`${baseUrl}/v1/search`, {
		method: "POST",
		headers: firecrawlHeaders(),
		body: JSON.stringify({
			query,
			limit: maxResults,
			scrapeOptions: { formats: [] }, // just search, don't scrape each result
		}),
		signal: AbortSignal.timeout(30000),
	});

	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`Firecrawl search error ${resp.status}: ${text}`);
	}

	const data = (await resp.json()) as {
		success: boolean;
		data: Array<{ title?: string; url?: string; description?: string }>;
	};

	return (data.data ?? []).slice(0, maxResults).map((d) => ({
		title: d.title ?? "",
		url: d.url ?? "",
		snippet: d.description ?? "",
	}));
}

async function searchSearXNG(query: string, maxResults: number): Promise<SearchResult[]> {
	const baseUrl = SEARXNG_BASE_URL!.replace(/\/+$/, "");
	const params = new URLSearchParams({
		q: query,
		format: "json",
		language: "en",
		categories: "general",
	});
	const resp = await fetch(`${baseUrl}/search?${params}`, {
		signal: AbortSignal.timeout(15000),
	});

	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`SearXNG search error ${resp.status}: ${text}`);
	}

	const data = (await resp.json()) as {
		results: Array<{ title: string; url: string; content: string; publishedDate?: string }>;
	};

	return (data.results ?? []).slice(0, maxResults).map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.content ?? "",
		publishedDate: r.publishedDate,
	}));
}

async function searchTavily(query: string, opts: { maxResults: number; searchDepth: string; includeDomains?: string[]; excludeDomains?: string[]; }): Promise<SearchResult[]> {
	if (!TAVILY_API_KEY) throw new Error("TAVILY_API_KEY not set");

	const body: Record<string, unknown> = {
		query,
		max_results: opts.maxResults,
		search_depth: opts.searchDepth,
		include_answer: false,
	};
	if (opts.includeDomains?.length) body.include_domains = opts.includeDomains;
	if (opts.excludeDomains?.length) body.exclude_domains = opts.excludeDomains;

	const resp = await fetch("https://api.tavily.com/search", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${TAVILY_API_KEY}` },
		body: JSON.stringify(body),
	});

	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`Tavily API error ${resp.status}: ${text}`);
	}

	const data = (await resp.json()) as { results: Array<{ title: string; url: string; content: string; score: number; published_date?: string }> };
	return data.results.map((r) => ({
		title: r.title,
		url: r.url,
		snippet: r.content,
		score: r.score,
		publishedDate: r.published_date,
	}));
}

async function searchBrave(query: string, maxResults: number): Promise<SearchResult[]> {
	if (!BRAVE_API_KEY) throw new Error("BRAVE_API_KEY not set");

	const params = new URLSearchParams({ q: query, count: String(maxResults) });
	const resp = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
		headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": BRAVE_API_KEY },
	});

	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`Brave API error ${resp.status}: ${text}`);
	}

	const data = (await resp.json()) as { web?: { results: Array<{ title: string; url: string; description: string; age?: string }> } };
	return (data.web?.results ?? []).map((r) => ({
		title: r.title,
		url: r.url,
		snippet: r.description,
		publishedDate: r.age,
	}));
}

/**
 * Try providers in priority order: Firecrawl → SearXNG → Tavily → Brave.
 *
 * Fallthrough rules (air-gap-safe):
 *   - A thrown error (provider unreachable / HTTP error / timeout) always falls
 *     through to the next provider, local or cloud — so a Firecrawl *process*
 *     outage is recovered by the cloud chain when keys are set.
 *   - An empty-but-successful result falls through only to other LOCAL providers.
 *     We do NOT phone the cloud for an empty local result: Firecrawl soft-fails a
 *     backend outage as HTTP 200 + empty data, indistinguishable from a genuine
 *     zero-hit, so cascading empties to cloud would leak real queries off-box and
 *     defeat the air-gap. A persistent zero-source state is caught downstream by
 *     research_checkpoint's minSources gate, not papered over here.
 *
 * Returns the last empty result once the chain is exhausted; raises only if every
 * attempted provider threw, or none is configured.
 */
async function doSearch(query: string, opts: { maxResults: number; searchDepth: string; includeDomains?: string[]; excludeDomains?: string[]; }): Promise<{ provider: string; results: SearchResult[] }> {
	const maxResults = opts.maxResults;

	type Provider = { name: string; tier: "local" | "cloud"; run: () => Promise<SearchResult[]> };
	const chain: Provider[] = [];
	if (FIRECRAWL_BASE_URL) chain.push({ name: "firecrawl", tier: "local", run: () => searchFirecrawl(query, maxResults) });
	if (SEARXNG_BASE_URL)   chain.push({ name: "searxng",   tier: "local", run: () => searchSearXNG(query, maxResults) });
	if (TAVILY_API_KEY)     chain.push({ name: "tavily",    tier: "cloud", run: () => searchTavily(query, opts) });
	if (BRAVE_API_KEY)      chain.push({ name: "brave",     tier: "cloud", run: () => searchBrave(query, maxResults) });

	if (chain.length === 0) {
		const suggestions = [
			"  Firecrawl: FIRECRAWL_BASE_URL=http://localhost:3002 (see ~/repo/firecrawl/)",
			"  SearXNG:   SEARXNG_BASE_URL=http://localhost:4000",
			"  Tavily:    TAVILY_API_KEY (https://tavily.com, free: 1000 req/month)",
			"  Brave:     BRAVE_API_KEY (https://brave.com/search/api/, free: 2000 req/month)",
		];
		throw new Error(
			"No search provider available.\n" +
			"Set at least one of these environment variables:\n" + suggestions.join("\n")
		);
	}

	const failures: string[] = [];
	let lastEmpty: { provider: string; results: SearchResult[] } | null = null;
	let localAnswered = false; // a local provider returned successfully (even if empty)

	for (const p of chain) {
		// Air-gap guard: once any local provider has answered, don't cross into cloud on empties.
		if (p.tier === "cloud" && localAnswered) break;
		try {
			const results = applyDomainFilter(await p.run(), opts.includeDomains, opts.excludeDomains);
			if (p.tier === "local") localAnswered = true;
			if (results.length > 0) return { provider: p.name, results };
			lastEmpty = { provider: p.name, results }; // remember, keep trying within the allowed tier
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			failures.push(`${p.name}: ${msg}`);
			console.warn(`${p.name} search failed: ${msg}`);
		}
	}

	if (lastEmpty) return lastEmpty; // best-effort: surface the empty rather than erroring
	throw new Error(
		`All ${failures.length} attempted search provider(s) failed:\n` + failures.map((f) => `  ${f}`).join("\n")
	);
}

// ─── Content Extraction ───

/**
 * Extract content from a URL.
 * If Firecrawl is available, delegates to its /v1/scrape endpoint
 * which uses Playwright for proper JS rendering and Trafilatura/Markdown
 * extraction. Falls back to a basic fetch + regex strip.
 */
async function extractContent(url: string): Promise<ExtractResult> {
	// Try Firecrawl scrape first (best quality, JS-rendered)
	if (FIRECRAWL_BASE_URL) {
		try {
			return await extractWithFirecrawl(url);
		} catch (e) {
			console.warn(`Firecrawl extract failed: ${e instanceof Error ? e.message : e}`);
		}
	}

	// Fallback: basic fetch + regex stripping
	return extractWithFetch(url);
}

async function extractWithFirecrawl(url: string): Promise<ExtractResult> {
	const baseUrl = FIRECRAWL_BASE_URL!.replace(/\/+$/, "");
	const resp = await fetch(`${baseUrl}/v1/scrape`, {
		method: "POST",
		headers: firecrawlHeaders(),
		body: JSON.stringify({
			url,
			formats: ["markdown"],
		}),
		signal: AbortSignal.timeout(60000),
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
			// Firecrawl normalizes some meta but passes most raw meta keys straight through,
			// so author/date live under varying keys — read them via pickMeta, not fixed fields.
			metadata?: { title?: string; sourceURL?: string; [key: string]: unknown };
		};
	};

	if (data.success === false) throw new Error(`Firecrawl scrape unsuccessful: ${data.error ?? "unknown error"}`);

	const doc = data.data;
	if (!doc) throw new Error("Firecrawl returned empty document");

	const rawContent = doc.markdown ?? "";
	// A 200 with empty markdown (JS-heavy or blocked page) is not a usable extract — throw so the
	// caller falls back to extractWithFetch rather than returning a hollow "successful" empty result.
	if (!rawContent.trim()) throw new Error("Firecrawl returned no content (page may require JS or be blocked)");

	const title = doc.metadata?.title ?? doc.title ?? "";
	const author = pickMeta(doc.metadata, ["author", "article:author", "dc.creator", "parsely-author"]);
	const publishedDate = pickMeta(doc.metadata, ["publishedTime", "article:published_time", "date"]);
	const { content, wordCount } = truncateToWords(rawContent);

	return { title, url, content, author, publishedDate, wordCount, provider: "firecrawl" };
}

async function extractWithFetch(url: string): Promise<ExtractResult> {
	const resp = await fetch(url, {
		headers: {
			"User-Agent": "Mozilla/5.0 (compatible; PiDeepResearch/1.0)",
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		},
		redirect: "follow",
		signal: AbortSignal.timeout(15000),
	});

	if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);

	const html = await resp.text();

	// Simple content extraction — strip HTML tags, extract title and main content
	const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
	const title = titleMatch?.[1]?.replace(/&[^;]+;/g, " ").trim() ?? "";

	// Remove script, style, nav, header, footer tags
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

	// Try to extract author from meta tags
	const authorMatch = html.match(/<meta[^>]*name=["']author["'][^>]*content=["']([^"']+)["']/i);
	const author = authorMatch?.[1];

	// Try to extract publish date
	const dateMatch = html.match(/<meta[^>]*(?:property=["']article:published_time["']|name=["']date["'])[^>]*content=["']([^"']+)["']/i);
	const publishedDate = dateMatch?.[1];

	return { title, url, content: truncated, author, publishedDate, wordCount, provider: "fetch (basic)" };
}

// ─── Batch Search (parallel) ───

async function batchSearch(queries: string[], opts: { maxResults: number; searchDepth: string; includeDomains?: string[]; excludeDomains?: string[]; }): Promise<{ providers: string[]; results: Record<string, SearchResult[]>; failures: Record<string, string> }> {
	const settled = await Promise.allSettled(queries.map((q) => doSearch(q, opts)));

	const providers = new Set<string>();
	const results: Record<string, SearchResult[]> = {};
	const failures: Record<string, string> = {};
	for (let i = 0; i < queries.length; i++) {
		const s = settled[i];
		if (s.status === "fulfilled") {
			providers.add(s.value.provider);
			results[queries[i]] = s.value.results;
		} else {
			results[queries[i]] = [];
			failures[queries[i]] = s.reason instanceof Error ? s.reason.message : String(s.reason);
		}
	}
	return { providers: [...providers], results, failures };
}

// ─── Extension Entry Point ───

export default function (pi: ExtensionAPI) {
	// ── Tool: web_search ──
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: [
			"Search the web for information. Supports single query or batch queries (parallel).",
			"Returns ranked results with title, URL, snippet, and relevance score.",
			"Attempts local providers first (Firecrawl → SearXNG), then falls back to Tavily → Brave.",
			"Set FIRECRAWL_BASE_URL or SEARXNG_BASE_URL for fully local operation.",
			"If Firecrawl is behind HTTP Basic Auth (a reverse proxy), set FIRECRAWL_BASIC_AUTH=user:pass.",
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
			const searchDepth = params.search_depth ?? "basic";

			// Batch mode
			if (params.queries && params.queries.length > 0) {
				const { providers, results, failures } = await batchSearch(params.queries, {
					maxResults,
					searchDepth,
					includeDomains: params.include_domains,
					excludeDomains: params.exclude_domains,
				});
				const totalResults = Object.values(results).reduce((s, r) => s + r.length, 0);
				const via = providers.length ? providers.join(", ") : "no provider";
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

			const { provider, results } = await doSearch(params.query, {
				maxResults,
				searchDepth,
				includeDomains: params.include_domains,
				excludeDomains: params.exclude_domains,
			});

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
			"Uses Firecrawl's Playwright-based scraper when FIRECRAWL_BASE_URL is set.",
			"If Firecrawl is behind HTTP Basic Auth (a reverse proxy), set FIRECRAWL_BASIC_AUTH=user:pass.",
			"Use after web_search to read full content of promising results.",
		].join(" "),
		parameters: Type.Object({
			url: Type.String({ description: "URL of the web page to extract content from" }),
		}),

		async execute(_toolCallId, params) {
			try {
				const result = await extractContent(params.url);
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

	const DEPTH_THRESHOLDS: Record<string, {
		minSearchRounds: number;
		maxSearchRounds: number;
		minSources: number;
		confidenceThreshold: number;
		minAnsweredRatio: number;
	}> = {
		quick:      { minSearchRounds: 1, maxSearchRounds: 3,  minSources: 3,  confidenceThreshold: 60, minAnsweredRatio: 0.6 },
		standard:   { minSearchRounds: 2, maxSearchRounds: 6,  minSources: 5,  confidenceThreshold: 75, minAnsweredRatio: 0.7 },
		deep:       { minSearchRounds: 3, maxSearchRounds: 10, minSources: 10, confidenceThreshold: 85, minAnsweredRatio: 0.8 },
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
			const answeredCount = params.sub_questions.filter(q => q.answered).length;
			const answeredRatio = totalQuestions > 0 ? answeredCount / totalQuestions : 0;
			const avgConfidence = totalQuestions > 0
				? params.sub_questions.reduce((sum, q) => sum + q.confidence, 0) / totalQuestions
				: 0;
			const minConfidence = totalQuestions > 0
				? Math.min(...params.sub_questions.map(q => q.confidence))
				: 0;
			const hasContradictions = (params.contradictions?.length ?? 0) > 0;
			const lowConfidenceQuestions = params.sub_questions.filter(q => q.confidence < 40);
			const medConfidenceQuestions = params.sub_questions.filter(q => q.confidence >= 40 && q.confidence < thresholds.confidenceThreshold);

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
				issues.push(`⛔ Answered ratio too low: ${answeredCount}/${totalQuestions} (${(answeredRatio * 100).toFixed(0)}% < ${(thresholds.minAnsweredRatio * 100).toFixed(0)}%)`);
			}

			// Rule 4: Average confidence below threshold
			if (avgConfidence < thresholds.confidenceThreshold) {
				verdict = "CONTINUE";
				issues.push(`⛔ Average confidence too low: ${avgConfidence.toFixed(0)}% < ${thresholds.confidenceThreshold}%`);
			}

			// Rule 5: Any question with very low confidence
			if (lowConfidenceQuestions.length > 0 && params.round < thresholds.maxSearchRounds) {
				verdict = "CONTINUE";
				const names = lowConfidenceQuestions.map(q => `"${q.question}" (${q.confidence}%)`).join(", ");
				issues.push(`⛔ Low-confidence sub-questions (<40%): ${names}`);
			}

			// Rule 6: Unresolved contradictions
			if (hasContradictions && params.round < thresholds.maxSearchRounds) {
				verdict = "CONTINUE";
				issues.push(`⚠️ Unresolved contradictions (${params.contradictions!.length}) — search for authoritative sources to verify`);
			}

			// Safety valve: don't exceed max rounds
			if (params.round >= thresholds.maxSearchRounds) {
				verdict = "PROCEED";
				if (issues.length > 0) {
					issues.push(`⚠️ Max search rounds reached (${thresholds.maxSearchRounds}). Proceeding to report. Remaining issues will be noted in "Uncertainties & Gaps".`);
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
				const icon = q.confidence >= thresholds.confidenceThreshold ? "✅" :
				             q.confidence >= 40 ? "🟡" : "🔴";
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
