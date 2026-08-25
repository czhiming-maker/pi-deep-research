import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createJiti } from "jiti";
import { loadPlugins, providersDir } from "../src/loader.ts";

let dir: string;
const jiti = createJiti(import.meta.url);

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pidr-plugins-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writePlugin(file: string, code: string) {
	await writeFile(join(dir, file), code);
}

describe("loadPlugins", () => {
	it("valid plugin loads and is returned", async () => {
		await writePlugin(
			"good.ts",
			`export default {
				name: "good",
				tier: "local",
				isConfigured: () => Boolean(process.env.GOOD_URL),
				search: async () => [{ title: "t", url: "https://x", snippet: "s" }],
			};`,
		);
		const { providers, warnings } = await loadPlugins(dir, ["tavily", "brave"], jiti);
		assert.equal(providers.length, 1);
		assert.equal(providers[0].name, "good");
		assert.deepEqual(warnings, []);
	});
	it("missing directory → empty result, no warnings, no throw", async () => {
		const { providers, warnings } = await loadPlugins(join(dir, "does-not-exist"), [], jiti);
		assert.deepEqual(providers, []);
		assert.deepEqual(warnings, []);
	});
	it("invalid shape (no search function) → skipped with warning naming the file", async () => {
		await writePlugin("bad.ts", `export default { name: "bad", tier: "local" };`);
		const { providers, warnings } = await loadPlugins(dir, [], jiti);
		assert.equal(providers.length, 0);
		assert.match(warnings[0], /bad\.ts/);
		assert.match(warnings[0], /"search"/);
	});
	it("import-throwing plugin → skipped with warning", async () => {
		await writePlugin("throws.ts", `throw new Error("boom on import");`);
		const { providers, warnings } = await loadPlugins(dir, [], jiti);
		assert.equal(providers.length, 0);
		assert.match(warnings[0], /throws\.ts/);
		assert.match(warnings[0], /boom on import/);
	});
	it("native-name collision → skipped with warning", async () => {
		await writePlugin(
			"shadow.ts",
			`export default { name: "tavily", tier: "cloud", isConfigured: () => true, search: async () => [] };`,
		);
		const { providers, warnings } = await loadPlugins(dir, ["tavily"], jiti);
		assert.equal(providers.length, 0);
		assert.match(warnings[0], /shadow\.ts/);
		assert.match(warnings[0], /reserved/);
	});
	it("duplicate plugin names → second file skipped, warning names both files", async () => {
		await writePlugin(
			"a1.ts",
			`export default { name: "dup", tier: "local", isConfigured: () => true, search: async () => [] };`,
		);
		await writePlugin(
			"b2.ts",
			`export default { name: "dup", tier: "local", isConfigured: () => true, search: async () => [] };`,
		);
		const { providers, warnings } = await loadPlugins(dir, [], jiti);
		assert.equal(providers.length, 1);
		assert.equal(providers[0].name, "dup");
		assert.match(warnings[0], /b2\.ts/);
		assert.match(warnings[0], /a1\.ts/);
	});
	it("uppercase/invalid name → skipped with warning", async () => {
		await writePlugin(
			"upper.ts",
			`export default { name: "MyProvider", tier: "cloud", isConfigured: () => true, search: async () => [] };`,
		);
		const { providers, warnings } = await loadPlugins(dir, [], jiti);
		assert.equal(providers.length, 0);
		assert.match(warnings[0], /a-z0-9/);
	});
	it("ignores non-.ts and .d.ts files", async () => {
		await writePlugin("readme.md", "not a plugin");
		await writePlugin("types.d.ts", "export {};");
		const { providers, warnings } = await loadPlugins(dir, [], jiti);
		assert.deepEqual(providers, []);
		assert.deepEqual(warnings, []);
	});
});

describe("providersDir", () => {
	it("is <home>/.pi/agent/pi-deep-research/providers", () => {
		assert.equal(providersDir("/home/u"), "/home/u/.pi/agent/pi-deep-research/providers");
	});
});
