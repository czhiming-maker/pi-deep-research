import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyDomainFilter, hostMatches, pickMeta, truncateToWords } from "../src/shared.ts";

describe("hostMatches", () => {
	it("matches exact host (case-insensitive)", () => {
		assert.equal(hostMatches("Example.COM", "example.com"), true);
	});
	it("matches subdomains", () => {
		assert.equal(hostMatches("www.example.com", "example.com"), true);
		assert.equal(hostMatches("a.b.example.com", "example.com"), true);
	});
	it("does not match suffix-lookalikes", () => {
		assert.equal(hostMatches("notexample.com", "example.com"), false);
		assert.equal(hostMatches("example.com.evil.io", "example.com"), false);
	});
	it("tolerates leading dots in the filter domain", () => {
		assert.equal(hostMatches("www.example.com", ".example.com"), true);
	});
});

describe("applyDomainFilter", () => {
	const results = [
		{ title: "a", url: "https://www.example.com/a", snippet: "" },
		{ title: "b", url: "https://docs.example.org/b", snippet: "" },
		{ title: "c", url: "https://other.net/c", snippet: "" },
	];
	it("passthrough when no filters", () => {
		assert.equal(applyDomainFilter(results).length, 3);
	});
	it("include keeps only matching domains", () => {
		assert.deepEqual(
			applyDomainFilter(results, ["example.org"]).map((r) => r.url),
			["https://docs.example.org/b"],
		);
	});
	it("include is subdomain-aware", () => {
		assert.equal(applyDomainFilter(results, ["example.com"]).length, 1);
	});
	it("exclude removes matching domains", () => {
		assert.equal(applyDomainFilter(results, undefined, ["example.com", "example.org"]).length, 1);
	});
	it("unparseable URL fails the include list but survives without filters", () => {
		const bad = [{ title: "x", url: "not a url", snippet: "" }];
		assert.equal(applyDomainFilter(bad, ["example.com"]).length, 0);
		assert.equal(applyDomainFilter(bad).length, 1);
	});
});

describe("truncateToWords", () => {
	it("returns short content unchanged with correct count", () => {
		const r = truncateToWords("one two three");
		assert.deepEqual(r, { content: "one two three", wordCount: 3 });
	});
	it("preserves newlines and markdown up to the cut", () => {
		const para = Array(4000).fill("word").join(" ");
		const long = `# Title\n\n${para}\n\n## Section\n\n${para}\n\n${para}`;
		const r = truncateToWords(long);
		assert.ok(r.content.startsWith("# Title\n"));
		assert.ok(r.content.includes("## Section"));
		assert.ok(r.content.endsWith(`\n\n[... truncated, total ${r.wordCount} words]`));
		assert.ok(r.wordCount > 8000);
		// the kept portion is at most 8000 words
		assert.equal(r.content.replace(/\n\n\[.*\]$/, "").split(/\s+/).filter(Boolean).length, 8000);
	});
	it("exact boundary content is not truncated", () => {
		const exact = Array(8000).fill("w").join(" ");
		const r = truncateToWords(exact);
		assert.ok(!r.content.includes("truncated"));
		assert.equal(r.wordCount, 8000);
	});
});

describe("pickMeta", () => {
	it("returns first non-empty string across keys", () => {
		assert.equal(pickMeta({ author: "", "article:author": "Ada" }, ["author", "article:author"]), "Ada");
	});
	it("reads first element of array values", () => {
		assert.equal(pickMeta({ author: ["Ada", "Bob"] }, ["author"]), "Ada");
	});
	it("returns undefined when nothing matches", () => {
		assert.equal(pickMeta({ x: 1 }, ["author"]), undefined);
		assert.equal(pickMeta(undefined, ["author"]), undefined);
	});
});
