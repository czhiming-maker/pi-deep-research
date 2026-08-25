# Example Provider Plugins

Copy-paste starting points for custom search providers. These are NOT
installed or loaded by default — copying a file into the plugin directory is
an explicit opt-in.

## Install a plugin

1. Copy the file into the plugin directory (create it if needed):

   ```bash
   mkdir -p ~/.pi/agent/pi-deep-research/providers
   cp examples/providers/searxng.ts ~/.pi/agent/pi-deep-research/providers/
   ```

2. Set whatever environment variables the plugin needs (see its header
   comment), e.g. `SEARXNG_BASE_URL=http://localhost:4000`.

3. List it in the chain — persistently in `~/.pi/agent/pi-deep-research/config.json`:

   ```json
   { "providers": ["searxng"] }
   ```

   or per-session with the env var (overrides the file):

   ```bash
   export SEARCH_PROVIDERS=searxng              # local only — cloud never contacted
   # or, local first with cloud fallback:
   export SEARCH_PROVIDERS=firecrawl,searxng,tavily,brave
   ```

4. Run `/reload` in pi (or restart). The plugin directory is re-scanned on
   every extension load — that is the hot-plug mechanism. There is no
   mid-session file watching.

Remove a plugin from the chain by removing it from `SEARCH_PROVIDERS` (the
file can stay); delete the file to remove it entirely.

## Write your own

A plugin is a single `.ts` file whose default export conforms to the
SearchProvider contract:

```ts
export default {
	name: "my-engine",            // required: lowercase [a-z0-9-], unique; "tavily"/"brave" are reserved
	tier: "local",                // "local" | "cloud" — display metadata only
	isConfigured: () => Boolean(process.env.MY_ENGINE_URL),  // false → skipped, recorded in attempts
	async search(req) {           // required: return [] on success-with-zero-hits; throw on failure
		// req: { query, maxResults, searchDepth?, signal? } — honor signal if you can
		return [{ title, url, snippet, score?, publishedDate? }];
	},
	// optional: extraction capability for web_extract
	async extract(url, signal) {
		return { title, url, content, wordCount, provider: "my-engine" };
	},
};
```

Chain semantics are uniform for every provider: not configured → skipped;
≥1 result after domain filtering → wins; empty → next provider; error → next
provider; all exhausted → aggregated error listing every attempt.

## Security notes

- Plugin code runs with your full user privileges — same trust level as
  `~/.pi/agent/extensions/`. Only install plugins you have read and trust.
- The plugin directory is global (`~/.pi/agent/pi-deep-research/providers/`).
  Project-level directories are deliberately not loaded — they would bypass
  pi's project trust gate.
