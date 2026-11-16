// What a release of WebCraft is made of: the commits since the last one, read as Conventional
// Commits (with or without a gitmoji in front), the version they call for, and the CHANGELOG.md
// section that describes them. Pure functions, so `scripts/release.ts` and its tests share them.

export type Bump = "major" | "minor" | "patch";

/** A plain `major.minor.patch` version. Pre-releases aren't made from main. */
export type Version = { major: number; minor: number; patch: number };

export type Commit = { hash: string; subject: string; body: string };

export type ChangeKind = "feature" | "fix" | "security" | "performance" | "other";

export type Change = {
	hash: string;
	kind: ChangeKind;
	/** The Conventional Commits type (`feat`, `fix`, `docs`, …). */
	type: string;
	scope: string | null;
	description: string;
	breaking: boolean;
};

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseVersion(text: string): Version {
	const match = VERSION_PATTERN.exec(text.trim().replace(/^v/, ""));
	if (!match) throw new Error(`"${text}" isn't a version (major.minor.patch).`);
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function formatVersion(version: Version): string {
	return `${version.major}.${version.minor}.${version.patch}`;
}

/** Negative when `a` is older than `b`, 0 when they are the same, positive when `a` is newer. */
export function compareVersions(a: Version, b: Version): number {
	return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function bumpVersion(version: Version, bump: Bump): Version {
	if (bump === "major") return { major: version.major + 1, minor: 0, patch: 0 };
	if (bump === "minor") return { major: version.major, minor: version.minor + 1, patch: 0 };
	return { ...version, patch: version.patch + 1 };
}

/** `<gitmoji> type(scope)!: description`, the gitmoji and the scope optional. */
const SUBJECT_PATTERN = /^(?:([^\w\s]\S*)\s+)?([a-z]+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/;

/**
 * Reads one commit, or null for what isn't a change of its own: merges (their commits are read one
 * by one) and release commits.
 */
export function parseCommit(commit: Commit): Change | null {
	const subject = commit.subject.trim();
	if (/^Merge (branch|pull request|remote-tracking branch)\b/.test(subject)) return null;
	const match = SUBJECT_PATTERN.exec(subject);
	if (!match)
		return { hash: commit.hash, kind: "other", type: "other", scope: null, description: subject, breaking: false };
	const [, gitmoji = "", type = "", scope, bang, description = ""] = match;
	if (type === "merge" || gitmoji.startsWith("🔀") || gitmoji.startsWith("🔖")) return null;
	const breaking = bang === "!" || gitmoji.startsWith("💥") || /^BREAKING[ -]CHANGE:/m.test(commit.body);
	return {
		hash: commit.hash,
		kind: changeKind(type, gitmoji),
		type,
		scope: scope ?? null,
		description,
		breaking,
	};
}

function changeKind(type: string, gitmoji: string): ChangeKind {
	if (gitmoji.startsWith("🔒")) return "security";
	if (type === "feat") return "feature";
	if (type === "fix") return "fix";
	if (type === "perf") return "performance";
	return "other";
}

/**
 * The bump these changes call for, or null when none of them changes what WebCraft does (only
 * tests, docs, refactors, chores). Before 1.0.0 a breaking change bumps the minor version, as
 * features do: 1.0.0 is a decision someone makes (`release:bump major`), never a commit's side effect.
 */
export function suggestedBump(current: Version, changes: Change[]): Bump | null {
	if (changes.some((change) => change.breaking)) return current.major === 0 ? "minor" : "major";
	if (changes.some((change) => change.kind === "feature")) return "minor";
	if (changes.some((change) => change.kind !== "other")) return "patch";
	return null;
}

const SECTIONS: { title: string; matches: (change: Change) => boolean }[] = [
	{ title: "Breaking changes", matches: (change) => change.breaking },
	{ title: "Features", matches: (change) => !change.breaking && change.kind === "feature" },
	{ title: "Fixes", matches: (change) => !change.breaking && change.kind === "fix" },
	{ title: "Security", matches: (change) => !change.breaking && change.kind === "security" },
	{ title: "Performance", matches: (change) => !change.breaking && change.kind === "performance" },
];

/** The CHANGELOG.md section for one release, newest commits first as `git log` lists them. */
export function changelogSection(options: {
	version: string;
	date: string;
	changes: Change[];
	/** The tag of the release before, for the comparison link; null for the first release. */
	previousTag: string | null;
	repositoryUrl: string;
}): string {
	const { version, date, changes, previousTag, repositoryUrl } = options;
	const heading = previousTag
		? `## [${version}](${repositoryUrl}/compare/${previousTag}...v${version}) - ${date}`
		: `## ${version} - ${date}`;
	const lines = [heading, ""];
	if (!previousTag) {
		lines.push("The first tagged release of WebCraft.", "");
		const counts = SECTIONS.map(({ title, matches }) => ({ title, count: changes.filter(matches).length })).filter(
			({ count }) => count > 0,
		);
		for (const { title, count } of counts) lines.push(`- ${title}: ${count}`);
		if (counts.length > 0) lines.push("");
		return lines.join("\n");
	}
	for (const { title, matches } of SECTIONS) {
		const listed = changes.filter(matches);
		if (listed.length === 0) continue;
		lines.push(`### ${title}`, "");
		for (const change of listed) {
			const scope = change.scope ? `**${change.scope}:** ` : "";
			lines.push(`- ${scope}${change.description} (${change.hash.slice(0, 8)})`);
		}
		lines.push("");
	}
	const others = changes.filter((change) => !SECTIONS.some(({ matches }) => matches(change))).length;
	if (others > 0)
		lines.push(`Also ${others} other ${others === 1 ? "change" : "changes"}: tests, docs, refactors and chores.`, "");
	return lines.join("\n");
}

export const CHANGELOG_HEADER =
	"# Changelog\n\nEvery release of WebCraft, newest first. `bun run release:bump` writes each section from the commits since the release before (see docs/development.md › Releases).\n";

/** The changelog with a new section on top (below the header). */
export function addToChangelog(changelog: string | null, section: string): string {
	const text = changelog?.trim() ? changelog : CHANGELOG_HEADER;
	const first = text.search(/^## /m);
	if (first === -1) return `${text.trimEnd()}\n\n${section.trimEnd()}\n`;
	return `${text.slice(0, first)}${section.trimEnd()}\n\n${text.slice(first)}`;
}

/** One release's section of the changelog, without its heading: the release notes. Null when it has none. */
export function releaseNotes(changelog: string, version: string): string | null {
	const sections = changelog.split(/^(?=## )/m);
	const section = sections.find((part) => new RegExp(`^## \\[?${version.replaceAll(".", "\\.")}\\]?[ (]`).test(part));
	if (!section) return null;
	return section.slice(section.indexOf("\n") + 1).trim();
}

/** Sets `"version"` in a package.json's text, keeping the rest of it exactly as it is. */
export function setPackageVersion(packageJson: string, version: string): string {
	const pattern = /^(\t| {2})"version": "[^"]*"/m;
	if (!pattern.test(packageJson)) throw new Error("package.json has no top-level version.");
	return packageJson.replace(pattern, `$1"version": "${version}"`);
}

export type Decision =
	| { release: true; version: string; tag: string; reason: string }
	| { release: false; version: string; reason: string };

/**
 * Whether the commit being merged into main makes a release. Only a raised version does: the root
 * package.json's version must be newer than the base's (the newest release when there is one, the
 * commit before otherwise), its tag must not exist yet, and CHANGELOG.md must describe it.
 */
export function decide(options: {
	version: string;
	baseVersion: string | null;
	tagExists: boolean;
	changelog: string | null;
}): Decision {
	const { version, baseVersion, tagExists, changelog } = options;
	const current = parseVersion(version);
	if (baseVersion !== null) {
		const order = compareVersions(current, parseVersion(baseVersion));
		if (order === 0) return { release: false, version, reason: `The version is still ${version}: no release.` };
		if (order < 0) throw new Error(`The version went down, from ${baseVersion} to ${version}.`);
	}
	if (tagExists) throw new Error(`v${version} is already released: raise the version again (bun run release:bump).`);
	if (!changelog || releaseNotes(changelog, version) === null) {
		throw new Error(`CHANGELOG.md has no section for ${version}: raise it with bun run release:bump.`);
	}
	return { release: true, version, tag: `v${version}`, reason: `Merging releases v${version}.` };
}
