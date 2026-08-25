import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	DEFAULT_PROVIDERS,
	parseProviderList,
	parseProvidersFile,
	providersConfigPath,
	readProviderOrder,
	resolveChain,
} from "../src/config.ts";
import type { SearchProvider } from "../src/types.ts";

function fake(name: string): SearchProvider {
	return {
		name,
		tier: "cloud",
		isConfigured: () => true,
		search: async () => [],
	};
}

describe("parseProviderList", () => {
	it("defaults to tavily,brave when unset", () => {
		assert.deepEqual(parseProviderList(undefined), ["tavily", "brave"]);
	});
	it("defaults on blank and all-empty-entry input", () => {
		assert.deepEqual(parseProviderList(""), DEFAULT_PROVIDERS.slice());
		assert.deepEqual(parseProviderList(" , , "), DEFAULT_PROVIDERS.slice());
	});
	it("trims and lowercases", () => {
		assert.deepEqual(parseProviderList(" Firecrawl , SEARXNG "), ["firecrawl", "searxng"]);
	});
	it("drops empty entries", () => {
		assert.deepEqual(parseProviderList("a,,b"), ["a", "b"]);
	});
	it("dedupes keeping first occurrence", () => {
		assert.deepEqual(parseProviderList("brave,tavily,brave"), ["brave", "tavily"]);
	});
});

describe("resolveChain", () => {
	const registry = [fake("tavily"), fake("brave"), fake("searxng")];
	it("resolves in the given order", () => {
		assert.deepEqual(
			resolveChain(registry, ["searxng", "tavily"]).map((p) => p.name),
			["searxng", "tavily"],
		);
	});
	it("empty order yields empty chain", () => {
		assert.deepEqual(resolveChain(registry, []), []);
	});
	it("unknown name throws listing unknown + available names", () => {
		assert.throws(() => resolveChain(registry, ["tavily", "nope"]), (e: Error) => {
			assert.match(e.message, /unknown provider "nope"/);
			assert.match(e.message, /brave, searxng, tavily/);
			return true;
		});
	});
});

describe("parseProvidersFile", () => {
	it("reads the providers array (raw, unnormalized — goes through parseProviderList semantics)", () => {
		assert.deepEqual(parseProvidersFile('{"providers": ["SearXNG", " tavily "]}'), ["SearXNG", " tavily "]);
	});
	it("missing providers key → undefined (file present but nothing configured)", () => {
		assert.equal(parseProvidersFile("{}"), undefined);
	});
	it("empty array → empty list (caller falls back to default)", () => {
		assert.deepEqual(parseProvidersFile('{"providers": []}'), []);
	});
	it("malformed JSON → throws naming the file", () => {
		assert.throws(() => parseProvidersFile("{broken"), /config\.json/);
	});
	it("wrong type for providers → throws naming the file", () => {
		assert.throws(() => parseProvidersFile('{"providers": "searxng"}'), /config\.json.*providers.*array/);
		assert.throws(() => parseProvidersFile('{"providers": [1, 2]}'), /config\.json.*providers.*array/);
	});
});

describe("readProviderOrder", () => {
	let dir: string;
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("env var wins over the config file", async () => {
		dir = await mkdtemp(join(tmpdir(), "pidr-cfg-"));
		const file = join(dir, "config.json");
		await writeFile(file, '{"providers": ["searxng"]}');
		assert.deepEqual(await readProviderOrder("firecrawl,tavily", file), ["firecrawl", "tavily"]);
	});
	it("reads the file when env is unset, with env-list normalization", async () => {
		dir = await mkdtemp(join(tmpdir(), "pidr-cfg-"));
		const file = join(dir, "config.json");
		await writeFile(file, '{"providers": ["SEARXNG", "searxng", "tavily"]}');
		assert.deepEqual(await readProviderOrder(undefined, file), ["searxng", "tavily"]);
	});
	it("missing file → default list", async () => {
		dir = await mkdtemp(join(tmpdir(), "pidr-cfg-"));
		assert.deepEqual(await readProviderOrder(undefined, join(dir, "nope.json")), DEFAULT_PROVIDERS.slice());
	});
	it("file with empty providers → default list", async () => {
		dir = await mkdtemp(join(tmpdir(), "pidr-cfg-"));
		const file = join(dir, "config.json");
		await writeFile(file, '{"providers": []}');
		assert.deepEqual(await readProviderOrder(undefined, file), DEFAULT_PROVIDERS.slice());
	});
	it("malformed config file → hard error (never silently fall back to cloud defaults)", async () => {
		dir = await mkdtemp(join(tmpdir(), "pidr-cfg-"));
		const file = join(dir, "config.json");
		await writeFile(file, "{broken");
		await assert.rejects(readProviderOrder(undefined, file), /config\.json/);
	});
	it("unreadable path (directory) → throws", async () => {
		dir = await mkdtemp(join(tmpdir(), "pidr-cfg-"));
		await assert.rejects(readProviderOrder(undefined, dir));
	});
});

describe("providersConfigPath", () => {
	it("is <home>/.pi/agent/pi-deep-research/config.json", () => {
		assert.equal(providersConfigPath("/home/u"), "/home/u/.pi/agent/pi-deep-research/config.json");
	});
});
