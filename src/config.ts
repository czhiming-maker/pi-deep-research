import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SearchProvider } from "./types.ts";

export const DEFAULT_PROVIDERS = ["tavily", "brave"];

/** Persistent config file (same directory as the plugin dir). */
export function providersConfigPath(home: string = homedir()): string {
	return join(home, ".pi", "agent", "pi-deep-research", "config.json");
}

/**
 * Parse SEARCH_PROVIDERS: comma-separated, ordered provider names.
 * Normalization: trim, lowercase, drop empty entries, dedupe keeping the
 * first occurrence. Blank/all-empty input falls back to the default list —
 * the list defines both the SET and the ORDER of the chain (air-gap users
 * simply list only local providers; cloud never enters the chain).
 */
export function parseProviderList(raw: string | undefined): string[] {
	if (!raw?.trim()) return [...DEFAULT_PROVIDERS];
	const seen = new Set<string>();
	for (const entry of raw.split(",")) {
		const name = entry.trim().toLowerCase();
		if (name) seen.add(name);
	}
	return seen.size > 0 ? [...seen] : [...DEFAULT_PROVIDERS];
}

/**
 * Parse the config file body: {"providers": ["name", ...]}.
 * Returns undefined when the file exists but has no "providers" key, and an
 * empty array for an explicit empty list. Malformed JSON or a wrong type is
 * a hard error — silently falling back to the (cloud) defaults would break
 * the air-gap guarantee for anyone whose only local-provider config is this file.
 */
export function parseProvidersFile(content: string): string[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (e) {
		throw new Error(
			`Invalid ~/.pi/agent/pi-deep-research/config.json: ${e instanceof Error ? e.message : String(e)}. ` +
				`Fix the JSON or delete the file to use the default providers (tavily,brave).`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Invalid ~/.pi/agent/pi-deep-research/config.json: top level must be an object.");
	}
	if (!("providers" in parsed)) return undefined;
	const providers = (parsed as { providers?: unknown }).providers;
	if (!Array.isArray(providers) || providers.some((v) => typeof v !== "string")) {
		throw new Error('Invalid ~/.pi/agent/pi-deep-research/config.json: "providers" must be an array of strings.');
	}
	return providers;
}

/**
 * Resolve the provider order: SEARCH_PROVIDERS env var (explicit, session-
 * scoped) → config.json "providers" (persistent) → default tavily,brave.
 * File read errors other than "file does not exist" propagate.
 */
export async function readProviderOrder(envRaw: string | undefined, configPath: string): Promise<string[]> {
	if (envRaw?.trim()) return parseProviderList(envRaw);

	let content: string;
	try {
		content = await readFile(configPath, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return [...DEFAULT_PROVIDERS];
		throw e;
	}

	const fromFile = parseProvidersFile(content);
	if (!fromFile || fromFile.length === 0) return [...DEFAULT_PROVIDERS];
	return parseProviderList(fromFile.join(","));
}

/**
 * Map an ordered name list onto registry providers.
 * Fail fast: an unknown name is a configuration error — the message lists
 * the unknown name and every available provider so the user can self-correct.
 */
export function resolveChain(registry: SearchProvider[], order: string[]): SearchProvider[] {
	const byName = new Map(registry.map((p) => [p.name, p]));
	const chain: SearchProvider[] = [];
	for (const name of order) {
		const provider = byName.get(name);
		if (!provider) {
			const available = registry
				.map((p) => p.name)
				.sort()
				.join(", ");
			throw new Error(
				`SEARCH_PROVIDERS references unknown provider "${name}". Available providers: ${available}. ` +
					`Custom providers are .ts files dropped into ~/.pi/agent/pi-deep-research/providers/ (see README → Custom Search Providers).`,
			);
		}
		chain.push(provider);
	}
	return chain;
}
