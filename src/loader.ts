import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Jiti } from "jiti";
import type { SearchProvider } from "./types.ts";

const NAME_RE = /^[a-z0-9-]+$/;

/** Global plugin directory (v1: global only — project-level dirs would bypass pi's project trust gate). */
export function providersDir(home: string = homedir()): string {
	return join(home, ".pi", "agent", "pi-deep-research", "providers");
}

export interface LoadResult {
	providers: SearchProvider[];
	warnings: string[];
}

/**
 * Scan a directory for provider plugins (.ts files whose default export
 * conforms to SearchProvider) and load them via jiti. A missing directory is
 * normal (no plugins). Every failure mode skips the offending file with a
 * warning — one bad plugin never blocks startup.
 */
export async function loadPlugins(dir: string, reserved: string[], jiti: Jiti): Promise<LoadResult> {
	const warnings: string[] = [];
	const providers: SearchProvider[] = [];

	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { providers, warnings };
		throw e;
	}

	const files = entries.filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts")).sort();
	const claimedBy = new Map<string, string>(); // provider name → file that claimed it

	for (const file of files) {
		const path = join(dir, file);
		let mod: { default?: unknown };
		try {
			mod = (await jiti.import(path)) as { default?: unknown };
		} catch (e) {
			warnings.push(
				`[pi-deep-research] skipped provider plugin ${file}: import failed (${e instanceof Error ? e.message : String(e)})`,
			);
			continue;
		}

		const def = mod?.default;
		if (
			typeof def !== "object" ||
			def === null ||
			typeof (def as SearchProvider).name !== "string" ||
			typeof (def as SearchProvider).search !== "function"
		) {
			warnings.push(
				`[pi-deep-research] skipped provider plugin ${file}: default export must be an object with a string "name" and a "search" function`,
			);
			continue;
		}

		const provider = def as SearchProvider;
		if (!NAME_RE.test(provider.name)) {
			warnings.push(
				`[pi-deep-research] skipped provider plugin ${file}: name "${provider.name}" must be lowercase [a-z0-9-]`,
			);
			continue;
		}
		if (reserved.includes(provider.name)) {
			warnings.push(
				`[pi-deep-research] skipped provider plugin ${file}: name "${provider.name}" is reserved for the built-in provider`,
			);
			continue;
		}
		const first = claimedBy.get(provider.name);
		if (first) {
			warnings.push(
				`[pi-deep-research] skipped provider plugin ${file}: name "${provider.name}" already loaded from ${first}`,
			);
			continue;
		}

		claimedBy.set(provider.name, file);
		providers.push(provider);
	}

	return { providers, warnings };
}
