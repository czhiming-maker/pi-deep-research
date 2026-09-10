#!/usr/bin/env node
/**
 * One-command release, modeled on pi-mono's scripts/release.mjs (single-package cut).
 *
 * Usage:
 *   npm run release:patch | release:minor | release:major
 *   node scripts/release.mjs <patch|minor|major|x.y.z>
 *
 * Steps:
 *  1. Refuse to run on a dirty working tree
 *  2. Bump package.json version
 *  3. CHANGELOG.md: [Unreleased] -> [x.y.z] - date (requires a non-empty Unreleased section)
 *  4. Tests + typecheck (fail fast, before any commit)
 *  5. Commit "chore: release x.y.z", tag vx.y.z
 *  6. Re-add an empty [Unreleased] section for the next cycle, commit
 *  7. Push main + tag
 *  8. npm publish (prepublishOnly re-runs tests)
 *  9. GitHub release via gh, notes extracted from the changelog section
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TARGET = process.argv[2];
const BUMPS = new Set(["patch", "minor", "major"]);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

if (!TARGET || (!BUMPS.has(TARGET) && !SEMVER_RE.test(TARGET))) {
	console.error("Usage: node scripts/release.mjs <patch|minor|major|x.y.z>");
	process.exit(1);
}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit", ...options });
	} catch {
		console.error(`Command failed: ${cmd}`);
		process.exit(1);
	}
}

function readVersion() {
	return JSON.parse(readFileSync("package.json", "utf-8")).version;
}

function bump(version, kind) {
	const [major, minor, patch] = version.split(".").map(Number);
	if (kind === "major") return `${major + 1}.0.0`;
	if (kind === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

const nextVersion = BUMPS.has(TARGET) ? bump(readVersion(), TARGET) : TARGET;
if (nextVersion === readVersion()) {
	console.error(`Version ${nextVersion} is not greater than current ${readVersion()}.`);
	process.exit(1);
}

// 1. Clean working tree
const status = run("git status --porcelain", { silent: true });
if (status?.trim()) {
	console.error("Error: uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}

// 2. The changelog must carry a non-empty [Unreleased] section — check before touching anything
const changelog = readFileSync("CHANGELOG.md", "utf-8");
const unreleasedBody = changelog.split("## [Unreleased]")[1]?.split("\n## ")[0] ?? "";
if (!unreleasedBody.trim()) {
	console.error("Error: CHANGELOG.md has no [Unreleased] section with content. Add entries there first.");
	process.exit(1);
}

// 3. Bump package.json, then version the changelog section
const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
pkg.version = nextVersion;
writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
const date = new Date().toISOString().split("T")[0];
writeFileSync("CHANGELOG.md", changelog.replace("## [Unreleased]", `## [${nextVersion}] - ${date}`));
console.log(`  CHANGELOG: [Unreleased] -> [${nextVersion}] - ${date}`);

// 4. Verify before committing anything
run("npm test");
run("npm run typecheck");

// 5. Release commit + tag
run("git add package.json CHANGELOG.md");
run(`git commit -m "chore: release ${nextVersion}"`);
run(`git tag v${nextVersion}`);

// 6. Fresh [Unreleased] for the next cycle
const after = readFileSync("CHANGELOG.md", "utf-8");
writeFileSync("CHANGELOG.md", after.replace(/^(# Changelog\n\n)/, "$1## [Unreleased]\n\n"));
run("git add CHANGELOG.md");
run('git commit -m "chore: add [Unreleased] section for next cycle"');

// 7. Push
run("git push origin main");
run(`git push origin v${nextVersion}`);

// 8. Publish (prepublishOnly re-runs tests + typecheck)
run("npm publish");

// 9. GitHub release with notes lifted from the versioned changelog section
const section = readFileSync("CHANGELOG.md", "utf-8")
	.split(`## [${nextVersion}]`)[1]
	?.split("\n## ")[0]
	.trim();
const notes = section.replace(/^[^\n]*\n/, "").trim();
// notes carry markdown (backticks, quotes) — pass via file so the shell never sees them
const notesFile = join(tmpdir(), `pi-deep-research-release-${nextVersion}.md`);
writeFileSync(notesFile, `${notes}\n`);
run(`gh release create v${nextVersion} --title "${nextVersion}" --notes-file "${notesFile}"`);

console.log(`\n=== Released ${nextVersion} (npm + tag + GitHub release) ===`);
console.log("Update the local pi extension with:  pi update npm:pi-deep-research");
