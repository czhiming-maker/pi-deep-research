/**
 * Native agent-reach provider — aggregates the agent-reach CLI toolchain
 * (https://github.com/Panniantong/Agent-Reach) as a single fan-out provider.
 *
 * One search is routed to several channels by query language and the results
 * are merged:
 *   CJK queries     → xiaohongshu + exa
 *   everything else → exa + twitter + reddit
 * Exa runs via `mcporter call exa.web_search_exa`; the social channels via
 * `opencli <platform> search -f json`. Social channels are complementary
 * evidence sources, not fallbacks — that is why this is one aggregating
 * provider instead of several chain entries (chain semantics are failover:
 * a healthy earlier provider would permanently shadow them).
 *
 * extract() uses Jina Reader via `curl https://r.jina.ai/<url>` — curl
 * inherits HTTP(S)_PROXY env vars, which node's global fetch ignores.
 *
 * Guardrails for the login-backed opencli channels (they reuse the browser
 * session, and platform throttling was observed to spike latency from ~2s to
 * ~16s under repeated calls):
 *   - per-channel call budget per provider instance (AGENT_REACH_MAX_CALLS, default 8)
 *   - channel breaker: 2 consecutive failures → 5min cooldown (AGENT_REACH_BREAKER_MS)
 *   - global opencli concurrency cap, default 1 (AGENT_REACH_OPENCLI_CONCURRENCY)
 *   - result cache per (channel, query)
 * A channel on a guardrail or a parse failure simply yields nothing; the
 * remaining channels still contribute results. All channels failing throws,
 * so the chain falls through to the next provider.
 *
 * isConfigured() probes for the `mcporter` / `opencli` binaries on PATH,
 * $AGENT_REACH_BIN_DIR, and nvm's bin dirs (pi may run without the user's
 * shell PATH). Both absent → the provider is skipped with a clean attempt
 * record, so machines without agent-reach are unaffected.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtractResult, SearchProvider, SearchRequest, SearchResult } from "../types.ts";

const pExecFile = promisify(execFile);

type ExecOptions = { timeout?: number; maxBuffer?: number; signal?: AbortSignal };
type ExecFn = (file: string, args: readonly string[], options: ExecOptions) => Promise<{ stdout: string; stderr?: string }>;

const CHANNEL_TIMEOUT_MS = 12_000;
const EXTRACT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 10 * 1024 * 1024;
const MAX_CALLS_DEFAULT = 8;
const BREAKER_THRESHOLD = 2;
const BREAKER_COOLDOWN_MS = 5 * 60_000;
const CACHE_LIMIT = 100;
const MAX_WORDS = 8000;

/** Dependency-injection point for offline tests (same convention as the fetch param of tavily/brave). */
export function createAgentReachProvider(exec: ExecFn = pExecFile as ExecFn, exists: (p: string) => boolean = existsSync): SearchProvider {
	// All mutable guardrail state lives in the factory closure: every provider
	// instance (and every test) starts from a clean slate.
	const binCache = new Map<string, string>();
	const callCounts = new Map<string, number>();
	const resultCache = new Map<string, SearchResult[]>();
	const channelFailures = new Map<string, { count: number; until: number }>();
	let opencliActive = 0;
	let opencliWaiters: Array<() => void> = [];

	// ── binary resolution ─────────────────────────────────────────────────
	function nvmBinDirs(home: string): string[] {
		const versionsRoot = join(home, ".nvm", "versions", "node");
		let versions: string[];
		try {
			versions = readdirSync(versionsRoot).filter((v) => /^\d/.test(v)).sort();
		} catch {
			return [];
		}
		return versions.map((v) => join(versionsRoot, v, "bin"));
	}

	function resolveBin(cmd: string): string {
		const cached = binCache.get(cmd);
		if (cached) return cached;

		const candidates: string[] = [];
		if (process.env.AGENT_REACH_BIN_DIR) candidates.push(process.env.AGENT_REACH_BIN_DIR);
		for (const dir of (process.env.PATH ?? "").split(":")) if (dir) candidates.push(dir);
		candidates.push(join(homedir(), ".local", "bin"));
		candidates.push(...nvmBinDirs(homedir()));

		const hit = candidates.find((dir) => exists(join(dir, cmd)));
		const resolved = hit ? join(hit, cmd) : cmd; // bare name = hope PATH works at spawn time
		binCache.set(cmd, resolved);
		return resolved;
	}

	async function run(bin: string, args: readonly string[], timeout: number, signal?: AbortSignal): Promise<string> {
		try {
			const { stdout } = await exec(resolveBin(bin), args, { timeout, maxBuffer: MAX_BUFFER, signal });
			return stdout;
		} catch (e) {
			// exec errors embed the full stderr (proxy warnings, banners) —
			// compress to the signal that actually matters for chain reporting.
			const err = e as { killed?: boolean; code?: string | number };
			const tail = String((e as { stderr?: string }).stderr ?? "")
				.split("\n")
				.filter((l) => !l.includes("Warning") && !l.includes("trace-warnings") && l.trim())
				.slice(-2)
				.join(" ");
			const why = err.killed ? `timed out after ${timeout}ms` : `exit ${err.code ?? "?"}`;
			throw new Error(`${bin} ${why}${tail ? `: ${tail.slice(0, 150)}` : ""}`);
		}
	}

	// ── channel adapters ──────────────────────────────────────────────────

	function oneLine(s: string, max = 300): string {
		const flat = s.replace(/\s+/g, " ").trim();
		return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
	}

	/** mcporter wraps the exa MCP server, whose text block is a human format:
	 * "Title: …\nURL: …\nPublished: …\nHighlights:\n…" separated by "---". */
	function parseExaText(text: string): SearchResult[] {
		const results: SearchResult[] = [];
		for (const block of text.split(/\n---+\n/)) {
			const title = block.match(/^Title: (.*)$/m)?.[1];
			const url = block.match(/^URL: (.*)$/m)?.[1];
			if (!title || !url) continue;
			const published = block.match(/^Published: (.*)$/m)?.[1];
			const highlights = block.split(/^Highlights:\s*$/m)[1] ?? "";
			const firstHighlight = highlights
				.split(/\n\.\.\.\n/)
				.map((s) => s.trim())
				.find((s) => s.length > 0);
			results.push({
				title,
				url,
				snippet: oneLine(firstHighlight ?? ""),
				publishedDate: published && published !== "N/A" ? published : undefined,
			});
		}
		return results;
	}

	interface Channel {
		name: string;
		usesOpencli: boolean;
		run(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]>;
	}

	const exaChannel: Channel = {
		name: "exa",
		usesOpencli: false,
		async run(query, limit, signal) {
			const args = [
				"call",
				"exa.web_search_exa",
				"--args",
				JSON.stringify({ query, numResults: Math.max(limit, 3) }),
				"--output",
				"json",
			];
			const stdout = await run("mcporter", args, envMs("AGENT_REACH_TIMEOUT_MS", CHANNEL_TIMEOUT_MS), signal);
			const parsed = JSON.parse(stdout) as { content?: Array<{ type?: string; text?: string }> };
			return parseExaText(parsed.content?.find((c) => c.type === "text")?.text ?? "");
		},
	};

	const xhsChannel: Channel = {
		name: "xhs",
		usesOpencli: true,
		async run(query, limit, signal) {
			// opencli ≥1.8.6 rejects the xiaohongshu navigation without a trace context
			// ("Navigation rejected", deterministic 8/8); retain-on-failure leaves no
			// artifact on success, ~8.5s per search either way.
			const args = ["xiaohongshu", "search", query, "--trace=retain-on-failure", "-f", "json"];
			const stdout = await run("opencli", args, CHANNEL_TIMEOUT_MS, signal);
			const items = JSON.parse(stdout) as Array<{
				title?: string;
				url?: string;
				author?: string;
				likes?: string;
				published_at?: string;
			}>;
			return items.slice(0, limit).map((it) => ({
				title: it.title ?? "",
				url: it.url ?? "",
				// xhs search results carry no text summary — synthesize one from metadata
				snippet: oneLine(`@${it.author ?? ""} · ${it.likes ?? "0"}赞`),
				publishedDate: it.published_at,
			}));
		},
	};

	const twitterChannel: Channel = {
		name: "twitter",
		usesOpencli: true,
		async run(query, limit, signal) {
			const stdout = await run("opencli", ["twitter", "search", query, "--limit", String(limit), "-f", "json"], CHANNEL_TIMEOUT_MS, signal);
			const items = JSON.parse(stdout) as Array<{
				author?: string;
				text?: string;
				url?: string;
				created_at?: string;
			}>;
			return items.map((it) => ({
				title: `@${it.author ?? ""}: ${oneLine(it.text ?? "", 80)}`,
				url: it.url ?? "",
				snippet: oneLine(it.text ?? ""),
				publishedDate: it.created_at ? new Date(it.created_at).toISOString() : undefined,
			}));
		},
	};

	const redditChannel: Channel = {
		name: "reddit",
		usesOpencli: true,
		async run(query, limit, signal) {
			const stdout = await run("opencli", ["reddit", "search", query, "-f", "json"], CHANNEL_TIMEOUT_MS, signal);
			const items = JSON.parse(stdout) as Array<{
				title?: string;
				url?: string;
				subreddit?: string;
				score?: number;
				comments?: number;
				selftext?: string;
				created_utc?: number;
			}>;
			return items.slice(0, limit).map((it) => ({
				title: it.title ?? "",
				url: it.url ?? "",
				snippet: oneLine(`↑${it.score ?? 0} · ${it.comments ?? 0}评论 — ${it.selftext ?? ""}`),
				publishedDate: it.created_utc ? new Date(it.created_utc * 1000).toISOString() : undefined,
			}));
		},
	};

	// ── guardrails ────────────────────────────────────────────────────────

	function envMs(key: string, fallback: number): number {
		const n = Number(process.env[key]);
		return Number.isFinite(n) && n > 0 ? n : fallback;
	}

	function maxCalls(): number {
		return envMs("AGENT_REACH_MAX_CALLS", MAX_CALLS_DEFAULT);
	}

	function breakerOpen(name: string): boolean {
		const b = channelFailures.get(name);
		return Boolean(b && b.count >= BREAKER_THRESHOLD && Date.now() < b.until);
	}

	function opencliLimit(): number {
		return envMs("AGENT_REACH_OPENCLI_CONCURRENCY", 1);
	}

	async function acquireOpencli(signal?: AbortSignal): Promise<void> {
		if (opencliActive >= opencliLimit()) {
			await new Promise<void>((resolve, reject) => {
				const wake = (): void => resolve();
				opencliWaiters.push(wake);
				// chain-level timeout (the req.signal) still applies while queued
				signal?.addEventListener(
					"abort",
					() => {
						opencliWaiters = opencliWaiters.filter((w) => w !== wake);
						reject(new Error("aborted while queued for opencli slot"));
					},
					{ once: true },
				);
			});
		}
		opencliActive++;
	}

	function releaseOpencli(): void {
		opencliActive--;
		const next = opencliWaiters.shift();
		if (next) next();
	}

	async function runChannel(channel: Channel, query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
		if (breakerOpen(channel.name)) return [];

		const budget = maxCalls();
		const used = callCounts.get(channel.name) ?? 0;
		if (used >= budget) {
			console.warn(`[agent-reach] channel ${channel.name}: call budget exhausted (${used}/${budget}), skipping`);
			return [];
		}

		const cacheKey = `${channel.name}::${query}`;
		const cached = resultCache.get(cacheKey);
		if (cached) return cached;

		callCounts.set(channel.name, used + 1);

		let results: SearchResult[];
		try {
			if (channel.usesOpencli) {
				await acquireOpencli(signal);
				try {
					results = await channel.run(query, limit, signal);
				} finally {
					releaseOpencli();
				}
			} else {
				results = await channel.run(query, limit, signal);
			}
		} catch (e) {
			const b = channelFailures.get(channel.name) ?? { count: 0, until: 0 };
			b.count += 1;
			b.until = Date.now() + envMs("AGENT_REACH_BREAKER_MS", BREAKER_COOLDOWN_MS);
			channelFailures.set(channel.name, b);
			throw e;
		}

		channelFailures.delete(channel.name); // success resets the breaker
		if (resultCache.size >= CACHE_LIMIT) resultCache.clear();
		resultCache.set(cacheKey, results);
		return results;
	}

	// ── public contract ───────────────────────────────────────────────────

	function hasCJK(query: string): boolean {
		return /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(query);
	}

	/** URL identity ignoring query strings (xhs URLs carry per-search tokens). */
	function urlIdentity(url: string): string {
		try {
			const u = new URL(url);
			return (u.hostname + u.pathname).replace(/\/+$/, "");
		} catch {
			return url;
		}
	}

	return {
		name: "agent-reach",
		tier: "cloud",
		isConfigured: () => {
			// Resolving to a bare name means `which` found nothing — treat the
			// tool as absent so the chain records a clean "skipped" attempt.
			return resolveBin("mcporter") !== "mcporter" || resolveBin("opencli") !== "opencli";
		},

		async search(req: SearchRequest): Promise<SearchResult[]> {
			const channels: Channel[] = hasCJK(req.query)
				? [xhsChannel, exaChannel]
				: [exaChannel, twitterChannel, redditChannel];
			const perChannel = Math.max(2, Math.min(3, req.maxResults));

			// opencli channels run through a global semaphore, exa runs free;
			// from here it's a uniform fan-out.
			const settled = await Promise.allSettled(channels.map((ch) => runChannel(ch, req.query, perChannel, req.signal)));

			const failures: string[] = [];
			const merged: SearchResult[] = [];
			const seen = new Set<string>();
			settled.forEach((s, i) => {
				if (s.status === "rejected") {
					failures.push(`${channels[i].name}: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`);
					return;
				}
				for (const r of s.value) {
					const id = urlIdentity(r.url);
					if (!r.url || seen.has(id)) continue;
					seen.add(id);
					merged.push(r);
				}
			});

			// Uniform chain semantics: every channel failing (or budget-exhausted
			// with nothing cached) is a provider failure → throw → next provider.
			if (merged.length === 0) {
				if (failures.length > 0) throw new Error(`agent-reach all channels failed: ${failures.join(" | ")}`);
				return [];
			}
			return merged.slice(0, req.maxResults);
		},

		async extract(url: string, signal?: AbortSignal): Promise<ExtractResult> {
			const raw = await run("curl", ["-s", "--max-time", "25", `https://r.jina.ai/${url}`], EXTRACT_TIMEOUT_MS, signal);

			let title = "";
			let body = raw;
			const marker = raw.match(/^Markdown Content:\s*$/m);
			if (marker?.index !== undefined) {
				title = raw.match(/^Title: (.*)$/m)?.[1]?.trim() ?? "";
				body = raw.slice(marker.index + marker[0].length);
			}
			const { content, wordCount } = truncateToWords(body.trim());
			if (!content) throw new Error("Jina Reader returned no content");
			return { title, url, content, wordCount, provider: "agent-reach" };
		},
	};
}

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
