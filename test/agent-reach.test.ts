import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createAgentReachProvider } from "../src/native/index.ts";

// ── test doubles ──────────────────────────────────────────────────────────

type Call = { bin: string; args: string[] };

function makeExec(handler: (bin: string, args: readonly string[]) => string) {
	const calls: Call[] = [];
	const exec = async (bin: string, args: readonly string[]): Promise<{ stdout: string }> => {
		calls.push({ bin, args: [...args] });
		return { stdout: handler(bin, args) };
	};
	return { exec, calls };
}

const MCPORTER_OK = JSON.stringify({
	content: [
		{
			type: "text",
			text:
				"Title: Exa Result\nURL: https://exa.example/post\nPublished: N/A\nAuthor: N/A\nHighlights:\nfirst highlight paragraph\n...\nsecond paragraph\n\n---\n\nTitle: Broken Block\n(no url here)",
		},
	],
});

const XHS_OK = JSON.stringify([
	{ rank: 1, author: "作者甲", likes: "7204", title: "小红书笔记", url: "https://www.xiaohongshu.com/search_result/abc?xsec_token=tok1", published_at: "2026-05-12" },
]);

const TWITTER_OK = JSON.stringify([
	{ id: "1", author: "someone", text: "tweet body line1\nline2", url: "https://x.com/i/status/1", created_at: "Thu Aug 27 13:11:07 +0000 2026" },
]);

const REDDIT_OK = JSON.stringify([
	{ id: "r1", title: "Reddit Post", subreddit: "r/x", author: "u", score: 58, comments: 13, url: "https://www.reddit.com/r/x/comments/r1/post/", created_utc: 1788075142, selftext: "post body" },
]);

/** run() passes the resolved absolute path — match by basename. */
function isBin(bin: string, name: string): boolean {
	return bin === name || bin.endsWith("/" + name);
}

function byPlatform(bin: string, args: readonly string[]): string {
	if (isBin(bin, "mcporter")) return MCPORTER_OK;
	if (isBin(bin, "opencli")) {
		if (args[0] === "xiaohongshu") return XHS_OK;
		if (args[0] === "twitter") return TWITTER_OK;
		if (args[0] === "reddit") return REDDIT_OK;
	}
	throw new Error(`unexpected exec ${bin} ${args.join(" ")}`);
}

beforeEach(() => {
	delete process.env.AGENT_REACH_MAX_CALLS;
	delete process.env.AGENT_REACH_OPENCLI_CONCURRENCY;
	delete process.env.AGENT_REACH_BREAKER_MS;
	delete process.env.AGENT_REACH_TIMEOUT_MS;
});
afterEach(() => {
	delete process.env.AGENT_REACH_MAX_CALLS;
	delete process.env.AGENT_REACH_OPENCLI_CONCURRENCY;
	delete process.env.AGENT_REACH_BREAKER_MS;
	delete process.env.AGENT_REACH_TIMEOUT_MS;
});

const existsNever = (): boolean => false;
const existsAll = (): boolean => true;

// ── isConfigured ──────────────────────────────────────────────────────────

describe("agent-reach isConfigured", () => {
	it("false when neither mcporter nor opencli resolves", () => {
		assert.equal(createAgentReachProvider(undefined, existsNever).isConfigured(), false);
	});
	it("true when at least one tool is found", () => {
		const existsMcporterOnly = (p: string): boolean => p.endsWith("/mcporter");
		assert.equal(createAgentReachProvider(undefined, existsMcporterOnly).isConfigured(), true);
	});
});

// ── routing ───────────────────────────────────────────────────────────────

describe("agent-reach routing", () => {
	it("CJK query fans out to xhs + exa only", async () => {
		const { exec, calls } = makeExec(byPlatform);
		const r = await createAgentReachProvider(exec, existsAll).search({ query: "Mac mini 值得买吗", maxResults: 5 });
		const platforms = calls.map((c) => (isBin(c.bin, "mcporter") ? "exa" : c.args[0]));
		assert.ok(platforms.includes("xiaohongshu") && platforms.includes("exa"));
		assert.ok(!platforms.includes("twitter") && !platforms.includes("reddit"));
		assert.ok(r.some((x) => x.url.includes("xiaohongshu.com")));
	});

	it("non-CJK query fans out to exa + twitter + reddit", async () => {
		const { exec, calls } = makeExec(byPlatform);
		const r = await createAgentReachProvider(exec, existsAll).search({ query: "rust async runtime", maxResults: 5 });
		const platforms = calls.map((c) => (isBin(c.bin, "mcporter") ? "exa" : c.args[0]));
		for (const want of ["exa", "twitter", "reddit"]) assert.ok(platforms.includes(want), `missing ${want}`);
		assert.ok(!platforms.includes("xiaohongshu"));
		assert.equal(r.length, 3); // exa(1 valid block) + twitter(1) + reddit(1)
	});
});

// ── mapping ───────────────────────────────────────────────────────────────

describe("agent-reach result mapping", () => {
	it("exa: parses Title/URL/Highlights, skips blocks without URL, drops Published N/A", async () => {
		const { exec } = makeExec(byPlatform);
		const r = await createAgentReachProvider(exec, existsAll).search({ query: "rust", maxResults: 5 });
		const exa = r.find((x) => x.url === "https://exa.example/post");
		assert.ok(exa);
		assert.equal(exa.title, "Exa Result");
		assert.equal(exa.snippet, "first highlight paragraph");
		assert.equal(exa.publishedDate, undefined);
		assert.ok(!r.some((x) => x.title === "Broken Block"), "URL-less block must be dropped");
	});

	it("xhs: synthesizes snippet from author/likes, keeps published_at", async () => {
		const { exec } = makeExec(byPlatform);
		const r = await createAgentReachProvider(exec, existsAll).search({ query: "中文", maxResults: 5 });
		const xhs = r.find((x) => x.url.includes("xiaohongshu.com"));
		assert.ok(xhs);
		assert.equal(xhs.snippet, "@作者甲 · 7204赞");
		assert.equal(xhs.publishedDate, "2026-05-12");
	});

	it("twitter: flattens multiline text into one-line snippet, converts created_at to ISO", async () => {
		const { exec } = makeExec(byPlatform);
		const r = await createAgentReachProvider(exec, existsAll).search({ query: "rust", maxResults: 5 });
		const tw = r.find((x) => x.url === "https://x.com/i/status/1");
		assert.ok(tw);
		assert.equal(tw.snippet, "tweet body line1 line2");
		assert.equal(tw.publishedDate, new Date("Thu Aug 27 13:11:07 +0000 2026").toISOString());
	});

	it("reddit: converts created_utc seconds to ISO", async () => {
		const { exec } = makeExec(byPlatform);
		const r = await createAgentReachProvider(exec, existsAll).search({ query: "rust", maxResults: 5 });
		const rd = r.find((x) => x.url.includes("reddit.com"));
		assert.ok(rd);
		assert.equal(rd.publishedDate, new Date(1788075142 * 1000).toISOString());
		assert.ok(rd.snippet.startsWith("↑58 · 13评论 — "));
	});

	it("merge dedupes URLs by origin+path (xhs per-search tokens ignored)", async () => {
		const dupXhs = JSON.stringify([
			{ rank: 1, author: "a", likes: "1", title: "one", url: "https://www.xiaohongshu.com/search_result/abc?xsec_token=t1" },
			{ rank: 2, author: "b", likes: "2", title: "dup", url: "https://www.xiaohongshu.com/search_result/abc?xsec_token=t2" },
		]);
		const { exec } = makeExec((bin, args) => {
			if (bin === "opencli" && args[0] === "xiaohongshu") return dupXhs;
			return byPlatform(bin, args);
		});
		const r = await createAgentReachProvider(exec, existsAll).search({ query: "中文", maxResults: 5 });
		assert.equal(r.filter((x) => x.url.includes("search_result/abc")).length, 1);
	});
});

// ── failure semantics ─────────────────────────────────────────────────────

describe("agent-reach failure semantics", () => {
	it("all channels failing → throws with every channel named", async () => {
		const { exec } = makeExec(() => {
			throw Object.assign(new Error("boom"), { killed: true, stderr: "(node:1) Warning: noise" });
		});
		await assert.rejects(
			createAgentReachProvider(exec, existsAll).search({ query: "rust", maxResults: 5 }),
			/all channels failed: exa: mcporter timed out after \d+ms \| twitter: opencli timed out after \d+ms \| reddit: opencli timed out after \d+ms/,
		);
	});

	it("partial failure → results from the healthy channel, failure invisible", async () => {
		const { exec } = makeExec((bin, args) => {
			if (isBin(bin, "opencli")) throw new Error("login expired");
			return byPlatform(bin, args);
		});
		const r = await createAgentReachProvider(exec, existsAll).search({ query: "rust", maxResults: 5 });
		assert.equal(r.length, 1);
		assert.equal(r[0].url, "https://exa.example/post");
	});

	it("exec errors are compressed (killed→timed out, stderr noise stripped)", async () => {
		const { exec } = makeExec(() => {
			throw Object.assign(new Error("Command failed"), { killed: true, stderr: "(node:1) UNDICI Warning: EnvHttpProxyAgent\nreal error" });
		});
		const p = createAgentReachProvider(exec, existsAll);
		await assert.rejects(p.search({ query: "中文", maxResults: 5 }), /timed out after \d+ms: real error/);
	});
});

// ── guardrails ────────────────────────────────────────────────────────────

describe("agent-reach guardrails", () => {
	it("cache: second identical query makes no new exec calls", async () => {
		const { exec, calls } = makeExec(byPlatform);
		const p = createAgentReachProvider(exec, existsAll);
		await p.search({ query: "rust async", maxResults: 5 });
		const n = calls.length;
		const r2 = await p.search({ query: "rust async", maxResults: 5 });
		assert.equal(calls.length, n);
		assert.ok(r2.length > 0);
	});

	it("breaker: channel failing twice is skipped on the next call", async () => {
		let twitterFails = true;
		const { exec, calls } = makeExec((bin, args) => {
			if (isBin(bin, "opencli") && args[0] === "twitter" && twitterFails) throw new Error("throttled");
			return byPlatform(bin, args);
		});
		const p = createAgentReachProvider(exec, existsAll);
		await p.search({ query: "rust one", maxResults: 5 }); // twitter fail #1
		await p.search({ query: "rust two", maxResults: 5 }); // twitter fail #2 → breaker armed
		const twitterCalls = calls.filter((c) => isBin(c.bin, "opencli") && c.args[0] === "twitter").length;
		await p.search({ query: "rust three", maxResults: 5 }); // breaker: no twitter call
		assert.equal(calls.filter((c) => isBin(c.bin, "opencli") && c.args[0] === "twitter").length, twitterCalls);
	});

	it("budget: AGENT_REACH_MAX_CALLS caps calls per channel", async () => {
		process.env.AGENT_REACH_MAX_CALLS = "1";
		const { exec, calls } = makeExec(byPlatform);
		const p = createAgentReachProvider(exec, existsAll);
		await p.search({ query: "rust one", maxResults: 5 });
		await p.search({ query: "rust two", maxResults: 5 }); // budget exhausted → skipped, not called
		const exaCalls = calls.filter((c) => isBin(c.bin, "mcporter")).length;
		assert.equal(exaCalls, 1);
	});

	it("a channel success resets the breaker", async () => {
		let fail = true;
		const { exec } = makeExec((bin, args) => {
			if (isBin(bin, "opencli") && args[0] === "twitter" && fail) throw new Error("throttled");
			return byPlatform(bin, args);
		});
		const p = createAgentReachProvider(exec, existsAll);
		await p.search({ query: "rust one", maxResults: 5 }); // fail #1
		fail = false;
		const r = await p.search({ query: "rust two", maxResults: 5 }); // success resets
		assert.ok(r.some((x) => x.url === "https://x.com/i/status/1"));
	});
});

// ── extract ───────────────────────────────────────────────────────────────

describe("agent-reach extract", () => {
	it("parses the Jina Reader header block", async () => {
		const jina = "Title: Example Domain\n\nURL Source: https://example.com/\n\nPublished Time: Sun, 30 Aug 2026\n\nMarkdown Content:\n\nExample body text here.";
		const { exec, calls } = makeExec((bin) => {
			if (isBin(bin, "curl")) return jina;
			throw new Error("unexpected");
		});
		const p = createAgentReachProvider(exec, existsAll);
		assert.ok(p.extract, "extract is implemented");
		const r = await p.extract("https://example.com/");
		assert.equal(r.title, "Example Domain");
		assert.equal(r.content, "Example body text here.");
		assert.equal(r.wordCount, 4);
		assert.equal(r.provider, "agent-reach");
		const first = calls[0];
		assert.ok(first, "curl was called");
		assert.ok(first.args.join(" ").includes("https://r.jina.ai/https://example.com/"));
	});

	it("empty content → throws (chain falls back to the basic fetch extractor)", async () => {
		const { exec } = makeExec(() => "");
		const p = createAgentReachProvider(exec, existsAll);
		assert.ok(p.extract, "extract is implemented");
		await assert.rejects(p.extract("https://example.com/"), /no content/);
	});
});
