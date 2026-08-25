---
description: "Changelog for pi-deep-research skill"
---

# Changelog

## [0.3.0] - 2026-08-25

Web search is rebuilt as a **hot-pluggable provider chain**: native support stays at Tavily and Brave; any other engine — including local ones like SearXNG or self-hosted Firecrawl — can be added by dropping a `.ts` plugin. Zero-config behavior is unchanged. Local-first direction from #4 by @fank, whose providers live on as example plugins.

### Added
- Custom search providers: drop a `.ts` file into `~/.pi/agent/pi-deep-research/providers/`, list it in the chain, `/reload` (contract and examples in `examples/`).
- Provider chain config: `SEARCH_PROVIDERS` env var or `~/.pi/agent/pi-deep-research/config.json` `{"providers": [...]}`; default `tavily,brave`. Listing only local providers keeps all search traffic off cloud APIs (air-gap friendly).
- Example plugins: `examples/providers/searxng.ts`, `firecrawl.ts`.
- Search failures report what every provider did, e.g. `Attempts: tavily → error (401), brave → empty`.
- Offline unit test suite (`npm test`).

### Changed
- Empty results and errors now fall through to the next provider (may consume Brave quota when Tavily returns nothing).
- Provider calls time out after 30s and fail over instead of hanging.
- `web_extract` prefers providers with extraction capability (e.g. Firecrawl) over the basic HTTP fetch; output names the extractor via `**Provider:**`.
- Batch search reports per-query failures instead of silently returning empty arrays.
- Truncation preserves markdown up to the cut; domain filters apply client-side across all providers with subdomain matching.

### Fixed
- Unknown provider names and malformed `config.json` fail fast at startup with actionable errors.
- Tool results match pi's `AgentToolResult` contract; removed the never-honored `isError` field.

Upgrading from 0.1.6: nothing to do — defaults, tool schemas, and output format are unchanged.

## [0.1.0] - 2026-03-21

### Added
- Initial release
- `web_search` tool (Tavily primary, Brave fallback, batch parallel)
- `web_extract` tool (full page content extraction)
- `research_checkpoint` tool (code-enforced reflection with CONTINUE/PROCEED verdicts)
- 4-phase research workflow: Plan → Search → Reflect → Report
- Multi-hop reasoning patterns: Entity Expansion, Temporal Progression, Conceptual Deepening, Causal Chain
- Source Triangulation for cross-validation
- Human-in-the-Loop plan approval gate
- `/research` slash command with 4 depth levels (quick, standard, deep, exhaustive)
- Strict English keyword matching for depth selection
- Markdown report output with structured sections
- Writing quality anti-patterns guidance
- Confidence scoring with calibration examples
