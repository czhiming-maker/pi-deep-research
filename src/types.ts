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
