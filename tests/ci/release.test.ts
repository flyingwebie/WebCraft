// Releases (scripts/release.ts, .github/workflows/release.yml): a change merged into main makes a
// release only when it raises the version in the root package.json, and the version it should be
// raised to comes from the commits since the last release.
import { describe, expect, test } from "bun:test";

import {
	addToChangelog,
	CHANGELOG_HEADER,
	type Change,
	changelogSection,
	decide,
	parseCommit,
	parseVersion,
	releaseNotes,
	setPackageVersion,
	suggestedBump,
} from "../../scripts/release/plan.ts";

const commit = (subject: string, body = "") => ({ hash: "0123456789abcdef", subject, body });
const changes = (...subjects: string[]) =>
	subjects.map((subject) => parseCommit(commit(subject))).filter((c) => c !== null);

describe("reading commits", () => {
	test("a gitmoji and a scope are optional", () => {
		expect(parseCommit(commit("✨ feat(forms): file fields"))).toMatchObject({
			kind: "feature",
			type: "feat",
			scope: "forms",
			description: "file fields",
			breaking: false,
		});
		expect(parseCommit(commit("fix: a crash"))).toMatchObject({ kind: "fix", scope: null, description: "a crash" });
		expect(parseCommit(commit("⚡️ perf(renderer): faster pages"))).toMatchObject({ kind: "performance" });
	});

	test("the lock gitmoji marks a security fix", () => {
		expect(parseCommit(commit("🔒️ fix(auth): sessions end on password change"))).toMatchObject({ kind: "security" });
		expect(parseCommit(commit("🔒 fix(api): refuse other Sites"))).toMatchObject({ kind: "security" });
	});

	test("a bang, the boom gitmoji or a BREAKING CHANGE footer marks a breaking change", () => {
		expect(parseCommit(commit("✨ feat(api)!: rename entries.list"))?.breaking).toBe(true);
		expect(parseCommit(commit("💥 feat(api): drop v1"))?.breaking).toBe(true);
		expect(parseCommit(commit("✨ feat(api): new list", "BREAKING CHANGE: the old one is gone"))?.breaking).toBe(true);
	});

	test("merges and release commits aren't changes of their own", () => {
		expect(parseCommit(commit("🔀 merge: the building area (BA-28)"))).toBeNull();
		expect(parseCommit(commit("Merge branch 'main' into feature"))).toBeNull();
		expect(parseCommit(commit("🔖 chore(release): v0.2.0"))).toBeNull();
	});

	test("anything else is an other change", () => {
		expect(parseCommit(commit("Initial commit"))).toMatchObject({ kind: "other" });
		expect(parseCommit(commit("📝 docs: the glossary"))).toMatchObject({ kind: "other" });
	});
});

describe("the version the changes call for", () => {
	const v1 = parseVersion("1.4.2");
	const v0 = parseVersion("0.3.1");

	test("breaking → major, feature → minor, fix → patch", () => {
		expect(suggestedBump(v1, changes("✨ feat!: x", "🐛 fix: y"))).toBe("major");
		expect(suggestedBump(v1, changes("✨ feat: x", "🐛 fix: y"))).toBe("minor");
		expect(suggestedBump(v1, changes("🐛 fix: y", "📝 docs: z"))).toBe("patch");
		expect(suggestedBump(v1, changes("🔒️ fix: y"))).toBe("patch");
	});

	test("before 1.0.0 a breaking change raises the minor version: 1.0.0 is chosen, never implied", () => {
		expect(suggestedBump(v0, changes("✨ feat!: x"))).toBe("minor");
	});

	test("only tests, docs, refactors and chores call for no release", () => {
		expect(suggestedBump(v1, changes("✅ test: x", "📝 docs: y", "♻️ refactor: z", "🔧 chore: w"))).toBeNull();
	});
});

describe("the changelog", () => {
	const listed: Change[] = changes(
		"✨ feat(forms): file fields",
		"🐛 fix(media): a crash",
		"🔒️ fix(auth): sessions",
		"✅ test: more",
		"✨ feat(api)!: rename",
	);

	test("a release lists its changes by kind, linked to the comparison with the release before", () => {
		const section = changelogSection({
			version: "1.5.0",
			date: "2026-11-16",
			changes: listed,
			previousTag: "v1.4.2",
			repositoryUrl: "https://github.com/example/webcraft",
		});
		expect(section).toBe(
			[
				"## [1.5.0](https://github.com/example/webcraft/compare/v1.4.2...v1.5.0) - 2026-11-16",
				"",
				"### Breaking changes",
				"",
				"- **api:** rename (01234567)",
				"",
				"### Features",
				"",
				"- **forms:** file fields (01234567)",
				"",
				"### Fixes",
				"",
				"- **media:** a crash (01234567)",
				"",
				"### Security",
				"",
				"- **auth:** sessions (01234567)",
				"",
				"Also 1 other change: tests, docs, refactors and chores.",
				"",
			].join("\n"),
		);
	});

	test("the first release counts its changes instead of listing the whole history", () => {
		const section = changelogSection({
			version: "0.2.0",
			date: "2026-11-16",
			changes: listed,
			previousTag: null,
			repositoryUrl: "https://github.com/example/webcraft",
		});
		expect(section).toContain("## 0.2.0 - 2026-11-16");
		expect(section).toContain("- Features: 1");
		expect(section).not.toContain("file fields");
	});

	test("a new section goes on top, and its notes can be read back for the GitHub release", () => {
		const first = addToChangelog(null, "## 0.2.0 - 2026-11-01\n\nThe first.\n");
		const second = addToChangelog(
			first,
			"## [0.3.0](https://x/compare/v0.2.0...v0.3.0) - 2026-11-16\n\n### Fixes\n\n- a\n",
		);
		expect(second.startsWith(CHANGELOG_HEADER)).toBe(true);
		expect(second.indexOf("0.3.0")).toBeLessThan(second.indexOf("## 0.2.0"));
		expect(releaseNotes(second, "0.3.0")).toBe("### Fixes\n\n- a");
		expect(releaseNotes(second, "0.2.0")).toBe("The first.");
		expect(releaseNotes(second, "0.2")).toBeNull();
		expect(releaseNotes(second, "0.4.0")).toBeNull();
	});
});

test("setting the version leaves the rest of package.json as it was", () => {
	const text = '{\n\t"name": "webcraft",\n\t"version": "0.1.0",\n\t"private": true\n}\n';
	expect(setPackageVersion(text, "0.2.0")).toBe(
		'{\n\t"name": "webcraft",\n\t"version": "0.2.0",\n\t"private": true\n}\n',
	);
});

describe("whether a merge into main releases", () => {
	const changelog = addToChangelog(null, "## 0.2.0 - 2026-11-16\n\nNotes.\n");

	test("an unchanged version makes no release", () => {
		expect(decide({ version: "0.1.0", baseVersion: "0.1.0", tagExists: false, changelog: null })).toMatchObject({
			release: false,
		});
	});

	test("a raised version with its changelog section releases its tag", () => {
		expect(decide({ version: "0.2.0", baseVersion: "0.1.0", tagExists: false, changelog })).toEqual({
			release: true,
			version: "0.2.0",
			tag: "v0.2.0",
			reason: "Merging releases v0.2.0.",
		});
	});

	test("a lowered version, a version already released or one the changelog lacks is refused", () => {
		expect(() => decide({ version: "0.1.0", baseVersion: "0.2.0", tagExists: false, changelog })).toThrow(/went down/);
		expect(() => decide({ version: "0.2.0", baseVersion: "0.1.0", tagExists: true, changelog })).toThrow(
			/already released/,
		);
		expect(() => decide({ version: "0.3.0", baseVersion: "0.2.0", tagExists: false, changelog })).toThrow(/no section/);
	});
});
