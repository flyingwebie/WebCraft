// Releases: the version in the root package.json is WebCraft's (WEBCRAFT_VERSION), and a change merged
// into main that raises it makes a release (.github/workflows/release.yml). See docs/development.md ›
// Releases.
//
//   bun run release:plan                         what the commits since the last release call for
//   bun run release:bump [major|minor|patch|x.y.z] [--commit]
//                                                raises the version and writes its CHANGELOG.md section
//   bun scripts/release.ts notes <version>       that section, as the GitHub release's notes
//   bun scripts/release.ts decide --base <ref|auto> [--output <file>] [--summary <file>]
//                                                whether this commit makes a release (for the workflow)
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	addToChangelog,
	type Bump,
	bumpVersion,
	type Commit,
	changelogSection,
	compareVersions,
	decide,
	formatVersion,
	parseCommit,
	parseVersion,
	releaseNotes,
	setPackageVersion,
	suggestedBump,
} from "./release/plan.ts";

const ROOT = join(import.meta.dir, "..");
const PACKAGE_JSON = join(ROOT, "package.json");
const CHANGELOG = join(ROOT, "CHANGELOG.md");

function git(...args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
	return result.stdout.toString();
}

function tryGit(...args: string[]): string | null {
	try {
		return git(...args);
	} catch {
		return null;
	}
}

const currentVersion = (): string => JSON.parse(readFileSync(PACKAGE_JSON, "utf8")).version;

const readChangelog = (): string | null => (existsSync(CHANGELOG) ? readFileSync(CHANGELOG, "utf8") : null);

/** The newest release tag reachable from HEAD, or null before the first release. */
function previousTag(): string | null {
	return tryGit("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*.[0-9]*.[0-9]*", "HEAD")?.trim() || null;
}

function commitsSince(tag: string | null): Commit[] {
	const range = tag ? `${tag}..HEAD` : "HEAD";
	return git("log", "--format=%H%x1f%s%x1f%b%x1e", range)
		.split("\x1e")
		.map((record) => record.replace(/^\n/, ""))
		.filter((record) => record.trim() !== "")
		.map((record) => {
			const [hash = "", subject = "", body = ""] = record.split("\x1f");
			return { hash, subject, body };
		});
}

/** The GitHub repository's address, from the origin remote (as actions/checkout sets it too). */
function repositoryUrl(): string {
	const remote = tryGit("remote", "get-url", "origin")?.trim() ?? "";
	const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
	if (!match) throw new Error("Can't tell the GitHub repository from the origin remote.");
	return `https://github.com/${match[1]}`;
}

function plan(level: string | undefined) {
	const version = currentVersion();
	const current = parseVersion(version);
	const tag = previousTag();
	const changes = commitsSince(tag)
		.map(parseCommit)
		.filter((change) => change !== null);
	const suggested = suggestedBump(current, changes);
	let next: string | null = null;
	if (level && /^\d/.test(level)) {
		next = formatVersion(parseVersion(level));
		if (compareVersions(parseVersion(next), current) <= 0) throw new Error(`${next} isn't newer than ${version}.`);
	} else if (level) {
		if (!["major", "minor", "patch"].includes(level))
			throw new Error(`"${level}" isn't major, minor, patch or a version.`);
		next = formatVersion(bumpVersion(current, level as Bump));
	} else if (suggested) {
		next = formatVersion(bumpVersion(current, suggested));
	}
	return { version, tag, changes, suggested, next };
}

function summary(result: ReturnType<typeof plan>): string {
	const counts = new Map<string, number>();
	for (const change of result.changes) {
		const key = change.breaking ? "breaking" : change.kind;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [
		`Version now:   ${result.version}`,
		`Last release:  ${result.tag ?? "none yet"}`,
		`Changes since: ${result.changes.length} (${[...counts].map(([kind, count]) => `${count} ${kind}`).join(", ") || "none"})`,
		`Suggested:     ${result.suggested ?? "no release: nothing but tests, docs, refactors and chores"}`,
	].join("\n");
}

function bump(args: string[]) {
	const commit = args.includes("--commit");
	const level = args.find((arg) => !arg.startsWith("--"));
	if (commit && git("status", "--porcelain").trim() !== "") {
		throw new Error("--commit needs a clean working tree, so the release commit holds only the release.");
	}
	const result = plan(level);
	console.log(summary(result));
	if (!result.next) {
		throw new Error("Nothing calls for a release. To release anyway, name the bump: release:bump patch.");
	}
	if (tryGit("rev-parse", "-q", "--verify", `refs/tags/v${result.next}`))
		throw new Error(`v${result.next} already exists.`);
	const section = changelogSection({
		version: result.next,
		date: new Date().toISOString().slice(0, 10),
		changes: result.changes,
		previousTag: result.tag,
		repositoryUrl: repositoryUrl(),
	});
	writeFileSync(PACKAGE_JSON, setPackageVersion(readFileSync(PACKAGE_JSON, "utf8"), result.next));
	writeFileSync(CHANGELOG, addToChangelog(readChangelog(), section));
	console.log(`\n${result.version} → ${result.next}: package.json and CHANGELOG.md updated.`);
	if (commit) {
		git("add", "package.json", "CHANGELOG.md");
		git("commit", "-m", `🔖 chore(release): v${result.next}`);
		console.log(`Committed. Open a pull request into main; merging it releases v${result.next}.`);
	} else {
		console.log(
			`Read CHANGELOG.md, edit it if you like, then commit both. Merging into main releases v${result.next}.`,
		);
	}
}

function versionAt(ref: string): string | null {
	const text = tryGit("show", `${ref}:package.json`);
	return text ? JSON.parse(text).version : null;
}

function decideCommand(args: string[]) {
	const option = (name: string) => {
		const index = args.indexOf(name);
		return index === -1 ? undefined : args[index + 1];
	};
	const base = option("--base") ?? "auto";
	const version = currentVersion();
	let baseVersion: string | null;
	if (base === "auto") {
		// On main: against the newest release, or before the first one, against the commit before.
		const tag = previousTag();
		baseVersion = tag ? tag.slice(1) : versionAt("HEAD^1");
	} else {
		baseVersion = versionAt(base);
	}
	const tagExists = tryGit("rev-parse", "-q", "--verify", `refs/tags/v${version}`) !== null;
	const output = option("--output");
	const summaryFile = option("--summary");
	try {
		const decision = decide({ version, baseVersion, tagExists, changelog: readChangelog() });
		console.log(decision.reason);
		if (output) {
			appendFileSync(output, `release=${decision.release}\nversion=${decision.version}\n`);
			if (decision.release) appendFileSync(output, `tag=${decision.tag}\n`);
		}
		if (summaryFile) appendFileSync(summaryFile, `### Release\n\n${decision.reason}\n`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.log(`::error::${message}`);
		if (summaryFile) appendFileSync(summaryFile, `### Release\n\n${message}\n`);
		process.exit(1);
	}
}

const [command = "plan", ...rest] = process.argv.slice(2);
try {
	if (command === "plan") {
		const result = plan(rest.find((arg) => !arg.startsWith("--")));
		console.log(summary(result));
		if (result.next) console.log(`Next version:  ${result.next}`);
	} else if (command === "bump") {
		bump(rest);
	} else if (command === "notes") {
		const version = rest[0] ?? currentVersion();
		const notes = releaseNotes(readChangelog() ?? "", version);
		if (notes === null) throw new Error(`CHANGELOG.md has no section for ${version}.`);
		console.log(notes);
	} else if (command === "decide") {
		decideCommand(rest);
	} else {
		throw new Error(`Unknown command "${command}": plan, bump, notes or decide.`);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}
