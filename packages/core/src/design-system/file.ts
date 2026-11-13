/**
 * The Design system file (spec story 63): a whole Design system as one versioned JSON file, to reuse
 * between Sites or keep a copy. It holds the same pieces `webcraft structure pull` writes as separate
 * files: the Design tokens as DTCG (with WebCraft's details under `$extensions.webcraft`, as
 * `designSystem.exportTokens` writes them), every Class with its CSS as text (breakpoint styles by
 * the breakpoint token's name), the base styles, the Site's custom CSS and Dark mode.
 *
 * Importing one replaces the Draft (never the published version): it is worked out and shown first
 * (what each section gains, loses and changes), and goes ahead only with the confirmation that
 * preview answered, two steps for everyone, as Publish all is. Tokens and Classes keep their ids by
 * name, so elements using them stay linked; removing one something uses is refused with where.
 */
import { designSystems } from "@webcraft/db/schema";
import {
	BASE_TARGETS,
	contentHash,
	type DesignSystem,
	defaultDesignSystem,
	exportTokens,
	importTokens,
	readDesignSystem,
	stepRange,
	type Tokens,
} from "@webcraft/renderer";
import { askConfirmation, type Confirmation, useConfirmation } from "../confirmations.ts";
import { sameJson } from "../content/json.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { lockDesignSystem, writeDraft } from "./design-systems.ts";
import {
	type ClassInput,
	type DesignSystemChange,
	type DesignSystemView,
	editable,
	refuseRemovingUsed,
	viewOf,
	withChange,
} from "./drafts.ts";
import { DesignSystemFileInvalidError } from "./errors.ts";

/** What the file says it is. */
export const DESIGN_SYSTEM_FILE_FORMAT = "webcraft-design-system";

/** The version of the file's shape this WebCraft writes and reads. */
export const DESIGN_SYSTEM_FILE_VERSION = 1;

/** One Class in the file: its CSS as Staff write it. */
export type DesignSystemFileClass = {
	name: string;
	/** Declarations for every width. */
	styles: string;
	/** Declarations from a breakpoint's width up, by the breakpoint token's name. */
	breakpoints: Record<string, string>;
	/** The Class's own custom CSS. */
	css: string;
};

/** A Design system as a file. */
export type DesignSystemFile = {
	format: typeof DESIGN_SYSTEM_FILE_FORMAT;
	version: typeof DESIGN_SYSTEM_FILE_VERSION;
	darkMode: boolean;
	/** The Design tokens, as DTCG. */
	tokens: Record<string, unknown>;
	classes: DesignSystemFileClass[];
	/** Declarations per element (`BASE_TARGETS`). */
	baseStyles: Record<string, string>;
	customCss: string;
};

/** A section's names that an import adds, removes and changes. */
export type NameChanges = { added: string[]; removed: string[]; changed: string[] };

/** The kinds of Design token, as the file and the screen group them. */
export const TOKEN_KINDS = ["colours", "space", "text", "fonts", "radius", "shadows", "breakpoints", "widths"] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

/** What importing a file would change in the Draft: only what differs is listed. */
export type DesignSystemImportChanges = {
	tokens: ({ kind: TokenKind } & NameChanges)[];
	/** Token settings that change: the viewport fluid scales run between, the focus style, a scale's base or ratio. */
	tokenSettings: ("viewport" | "focus" | "space" | "text")[];
	classes: NameChanges;
	/** The elements whose base style changes. */
	baseStyles: string[];
	customCss: boolean;
	darkMode: { from: boolean; to: boolean } | null;
	/** Whether anything changes at all. */
	any: boolean;
};

/** The preview a file import is confirmed on: what changes, and the Draft it changes. */
export type DesignSystemImportPreview = {
	changes: DesignSystemImportChanges;
	/** The Draft it changes, by the hash of its content: a save in between asks for a new confirmation. */
	draft: string;
};

// ---------------------------------------------------------------------------------------------
// Export

/** The Site's Design system as a file: the Draft's, or the published one (the default one before). */
export async function exportDesignSystemFile(
	scope: SiteScope,
	version: "draft" | "published",
): Promise<DesignSystemFile> {
	const row = await scope.first(designSystems);
	const stored = version === "draft" ? row?.draft : row?.published;
	const file = designSystemFile(stored ? readDesignSystem(stored) : defaultDesignSystem(), scope.site.name);
	await scope.audit("designSystem.export", {
		version,
		classes: file.classes.length,
	});
	return file;
}

/** A Design system as a file. */
export function designSystemFile(designSystem: DesignSystem, siteName: string): DesignSystemFile {
	const shown = editable(designSystem);
	const breakpointName = new Map(designSystem.tokens.breakpoints.map((each) => [each.id, each.name]));
	return {
		format: DESIGN_SYSTEM_FILE_FORMAT,
		version: DESIGN_SYSTEM_FILE_VERSION,
		darkMode: shown.darkMode,
		tokens: exportTokens(designSystem.tokens, `Design tokens of ${siteName}`) as Record<string, unknown>,
		classes: shown.classes.map((each) => ({
			name: each.name,
			styles: each.styles,
			breakpoints: Object.fromEntries(
				Object.entries(each.breakpoints).map(([id, css]) => [breakpointName.get(id) ?? id, css]),
			),
			css: each.css,
		})),
		baseStyles: shown.baseStyles,
		customCss: shown.customCss,
	};
}

// ---------------------------------------------------------------------------------------------
// Import

/**
 * Imports a Design system file into the Draft, in two steps: without `confirmation` it changes
 * nothing and answers what would change and a confirmation; with the confirmation (5 minutes, once,
 * while the file and the Draft are unchanged) it replaces the Draft. Refused: a file that isn't a
 * Design system file this version reads (`DesignSystemFileInvalidError`, with every problem and
 * where), CSS or tokens that can't be saved (`DesignSystemInvalidError`), and leaving out a Class or
 * token something uses (`ClassInUseError`, `TokenInUseError`).
 */
export async function importDesignSystemFile(
	scope: SiteScope,
	file: unknown,
	confirmation?: string,
): Promise<{ confirmation: Confirmation; preview: DesignSystemImportPreview } | { designSystem: DesignSystemView }> {
	return scope.transaction(async (tx) => {
		const locked = await lockDesignSystem(tx);
		const next = withChange(locked.draft, changeFromFile(file, locked.draft));
		await refuseRemovingUsed(tx, locked.draft, next);
		const changes = importChanges(locked.draft, next);
		const preview: DesignSystemImportPreview = {
			changes,
			draft: contentHash(JSON.stringify(locked.row.draft)),
		};
		const request = { action: "designSystem.import", target: "designSystem", preview };
		if (confirmation === undefined) return { confirmation: await askConfirmation(tx, request), preview };
		await useConfirmation(tx, confirmation, request);
		if (changes.any) await writeDraft(tx, locked, next);
		await tx.audit("designSystem.import", {
			tokens: changes.tokens,
			tokenSettings: changes.tokenSettings,
			classes: changes.classes,
			baseStyles: changes.baseStyles,
			customCss: changes.customCss,
			darkMode: changes.darkMode,
		});
		// A no-op import (identical content) writes nothing, so it answers the Draft unchanged too.
		return {
			designSystem: viewOf(changes.any ? { ...locked.row, draft: next, updatedAt: tx.now() } : locked.row),
		};
	});
}

/** The change a file makes to the Draft: every section replaced by the file's. */
function changeFromFile(file: unknown, current: DesignSystem): DesignSystemChange {
	const problems: { at: string; message: string }[] = [];
	const problem = (at: string, message: string) => problems.push({ at, message });
	if (!isObject(file)) throw new DesignSystemFileInvalidError([{ at: "", message: "The file isn't a JSON object." }]);
	if (file.format !== DESIGN_SYSTEM_FILE_FORMAT) {
		problem("format", `This isn't a Design system file: its format should be "${DESIGN_SYSTEM_FILE_FORMAT}".`);
		throw new DesignSystemFileInvalidError(problems);
	}
	if (file.version !== DESIGN_SYSTEM_FILE_VERSION) {
		problem(
			"version",
			typeof file.version === "number" && file.version > DESIGN_SYSTEM_FILE_VERSION
				? `The file is version ${file.version}, made by a newer WebCraft: this one reads version ${DESIGN_SYSTEM_FILE_VERSION}.`
				: `The file's version should be ${DESIGN_SYSTEM_FILE_VERSION}.`,
		);
		throw new DesignSystemFileInvalidError(problems);
	}
	if (typeof file.darkMode !== "boolean") problem("darkMode", "Dark mode should be true or false.");
	if (typeof file.customCss !== "string") problem("customCss", "The custom CSS should be text.");

	let tokens: Tokens = current.tokens;
	if (!isObject(file.tokens)) problem("tokens", "The Design tokens should be a DTCG object.");
	else {
		const read = importTokens(withKnownIds(file.tokens, current.tokens), current.tokens);
		if ("problems" in read)
			for (const each of read.problems) problem(`tokens.${each.at}`.replace(/\.$/, ""), each.message);
		else tokens = read.tokens;
	}

	const baseStyles: Record<string, string> = {};
	if (!isObject(file.baseStyles)) problem("baseStyles", "The base styles should be an object of CSS by element.");
	else {
		for (const [target, css] of Object.entries(file.baseStyles)) {
			if (!(BASE_TARGETS as readonly string[]).includes(target))
				problem(`baseStyles.${target}`, `Base styles can't style ${target}.`);
			else if (typeof css !== "string") problem(`baseStyles.${target}`, "Each base style should be CSS text.");
			else baseStyles[target] = css;
		}
	}

	const classes: ClassInput[] = [];
	const breakpointId = new Map(tokens.breakpoints.map((each) => [each.name, each.id]));
	const classId = new Map(current.classes.map((each) => [each.name, each.id]));
	if (!Array.isArray(file.classes)) problem("classes", "The Classes should be a list.");
	else {
		for (const [index, each] of (file.classes as unknown[]).entries()) {
			const at = `classes[${index}]`;
			if (!isObject(each)) {
				problem(at, "Each Class should be an object.");
				continue;
			}
			if (typeof each.name !== "string" || !each.name) {
				problem(`${at}.name`, "Each Class needs a name.");
				continue;
			}
			for (const key of ["styles", "css"] as const) {
				if (each[key] !== undefined && typeof each[key] !== "string") problem(`${at}.${key}`, "CSS should be text.");
			}
			const breakpoints: Record<string, string> = {};
			if (each.breakpoints !== undefined && !isObject(each.breakpoints))
				problem(`${at}.breakpoints`, "Breakpoint styles should be an object of CSS by breakpoint name.");
			for (const [name, css] of Object.entries(isObject(each.breakpoints) ? each.breakpoints : {})) {
				const id = breakpointId.get(name);
				if (!id) problem(`${at}.breakpoints.${name}`, `There is no breakpoint named ${name} in the file's tokens.`);
				else if (typeof css !== "string") problem(`${at}.breakpoints.${name}`, "CSS should be text.");
				else breakpoints[id] = css;
			}
			const known = classId.get(each.name);
			classes.push({
				...(known ? { id: known } : {}),
				name: each.name,
				styles: typeof each.styles === "string" ? each.styles : "",
				breakpoints,
				css: typeof each.css === "string" ? each.css : "",
			});
		}
	}
	if (problems.length > 0) throw new DesignSystemFileInvalidError(problems);
	return {
		tokens,
		classes,
		// Elements the file leaves out lose their base style, as an empty one would.
		baseStyles,
		customCss: file.customCss as string,
		darkMode: file.darkMode as boolean,
	};
}

/**
 * The tokens of a file with only the ids this Site has: a token from another Site keeps its place
 * here by its name, so a colour named alike on both stays linked to what uses it.
 */
function withKnownIds(file: Record<string, unknown>, current: Tokens): Record<string, unknown> {
	const known = new Set<string>([
		...current.colours.map((each) => each.id),
		...current.space.steps.map((each) => each.id),
		...current.text.steps.map((each) => each.id),
		...current.fonts.map((each) => each.id),
		...current.radius.map((each) => each.id),
		...current.shadows.map((each) => each.id),
		...current.breakpoints.map((each) => each.id),
		...current.widths.map((each) => each.id),
	]);
	const walk = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(walk);
		if (!isObject(value)) return value;
		const copy: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value)) copy[key] = walk(inner);
		const ours = isObject(copy.$extensions) && isObject(copy.$extensions.webcraft) ? copy.$extensions.webcraft : null;
		if (ours && typeof ours.id === "string" && !known.has(ours.id)) {
			const { id: _, ...rest } = ours;
			copy.$extensions = { ...(copy.$extensions as Record<string, unknown>), webcraft: rest };
		}
		return copy;
	};
	return walk(file) as Record<string, unknown>;
}

/** What differs between the Draft and the Draft an import makes. */
export function importChanges(before: DesignSystem, after: DesignSystem): DesignSystemImportChanges {
	const tokens: DesignSystemImportChanges["tokens"] = [];
	for (const kind of TOKEN_KINDS) {
		const list = (designSystem: DesignSystem) => tokensOf(designSystem.tokens, kind);
		const changes = nameChanges(list(before), list(after));
		if (changes.added.length + changes.removed.length + changes.changed.length > 0) tokens.push({ kind, ...changes });
	}
	const tokenSettings: DesignSystemImportChanges["tokenSettings"] = [];
	if (!sameJson(before.tokens.viewport, after.tokens.viewport)) tokenSettings.push("viewport");
	if (!sameJson(before.tokens.focus, after.tokens.focus)) tokenSettings.push("focus");
	for (const scale of ["space", "text"] as const) {
		const settings = (each: Tokens) => ({ base: each[scale].base, ratio: each[scale].ratio });
		if (!sameJson(settings(before.tokens), settings(after.tokens))) tokenSettings.push(scale);
	}
	const classes = nameChanges(
		before.classes.map((each) => ({ id: each.id, name: each.name, value: each })),
		after.classes.map((each) => ({ id: each.id, name: each.name, value: each })),
	);
	const targets = new Set([...Object.keys(before.baseStyles), ...Object.keys(after.baseStyles)]);
	const baseStyles = BASE_TARGETS.filter(
		(target) => targets.has(target) && !sameJson(before.baseStyles[target] ?? [], after.baseStyles[target] ?? []),
	);
	const customCss = !sameJson(before.customCss, after.customCss);
	const darkMode = before.darkMode === after.darkMode ? null : { from: before.darkMode, to: after.darkMode };
	const any =
		tokens.length > 0 ||
		tokenSettings.length > 0 ||
		classes.added.length + classes.removed.length + classes.changed.length > 0 ||
		baseStyles.length > 0 ||
		customCss ||
		darkMode !== null ||
		// Class order counts too.
		!sameJson(
			before.classes.map((each) => each.id),
			after.classes.map((each) => each.id),
		);
	return { tokens, tokenSettings, classes, baseStyles, customCss, darkMode, any };
}

type Named = { id: string; name: string; value: unknown };

function tokensOf(tokens: Tokens, kind: TokenKind): Named[] {
	if (kind === "space" || kind === "text") {
		const scale = tokens[kind];
		return scale.steps.map((step) => ({
			id: step.id,
			name: step.name,
			// A step changes when its sizes do, whether by its own sizes or the scale's.
			value: { exponent: step.exponent, size: stepRange(scale, step), viewport: tokens.viewport },
		}));
	}
	return (tokens[kind] as readonly { id: string; name: string }[]).map((each) => ({
		id: each.id,
		name: each.name,
		value: each,
	}));
}

function nameChanges(before: readonly Named[], after: readonly Named[]): NameChanges {
	const old = new Map(before.map((each) => [each.id, each]));
	const kept = new Set(after.map((each) => each.id));
	return {
		added: after.filter((each) => !old.has(each.id)).map((each) => each.name),
		removed: before.filter((each) => !kept.has(each.id)).map((each) => each.name),
		changed: after
			.filter((each) => {
				const was = old.get(each.id);
				return was !== undefined && !sameJson(was.value, each.value);
			})
			.map((each) => each.name),
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
