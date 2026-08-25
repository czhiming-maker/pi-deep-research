import { applyDomainFilter, extractWithFetch } from "./shared.ts";
import type { Attempt, ExtractResult, SearchProvider, SearchResult } from "./types.ts";

export const DEFAULT_TIMEOUT_MS = 30_000;

export const NO_SEARCH_API_MESSAGE =
	"No search API configured. Set TAVILY_API_KEY or BRAVE_API_KEY environment variable.\n" +
	"  Tavily: https://tavily.com (free: 1000 req/month)\n" +
	"  Brave:  https://brave.com/search/api/ (free: 2000 req/month)\n" +
	"To use custom search providers, set SEARCH_PROVIDERS and drop a plugin into ~/.pi/agent/pi-deep-research/providers/ (see README → Custom Search Providers).";

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
