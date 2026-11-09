/**
 * The Draft of a Site's Design system as Staff read and change it (open the Site with
 * `structure.edit`): tokens as data, and every piece of CSS as text, with today's names of the
 * tokens and Classes it refers to. Stored CSS keeps those references by id (ADR 0009), so renaming a
 * token or a Class changes every use, and CSS sent back unchanged keeps its references even when
 * names changed in the same save. Classes and tokens in use can't be removed (`ClassInUseError`,
 * `TokenInUseError`, with where they are used).
 */
import { designSystems } from "@webcraft/db/schema";
import {
	BASE_TARGETS,
	type ColourToken,
	type CssKind,
	type CssText,
	type DesignClass,
	type DesignSystem,
	DesignSystemInvalidError,
	type DesignSystemNames,
	type DesignSystemProblem,
	defaultDesignSystem,
	designSystemNames,
	designSystemProblems,
	exportTokens,
	type FontToken,
	importTokens,
	printCss,
	readCssAt,
	readDesignSystem,
	type Scale,
	type ScaleStep,
	type ShadowToken,
	type Tokens,
} from "@webcraft/renderer";

import { sameJson } from "../content/json.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { type DesignSystemRow, lockDesignSystem, writeDraft } from "./design-systems.ts";
import { ClassInUseError, ClassNotFoundError, TokenInUseError, TokensFileInvalidError } from "./errors.ts";
import { classUses, tokenUses } from "./usage.ts";

/** A Class as Staff edit it: its CSS as text. */
export type EditableClass = {
	id: string;
	name: string;
	/** Made by WebCraft from an inline style; it stops being generated once Staff change it. */
	generated: boolean;
	/** Declarations for every width. */
	styles: string;
	/** Declarations from a breakpoint's width up, by the breakpoint token's id. */
	breakpoints: Record<string, string>;
	/** The Class's own custom CSS: declarations and rules nested with `&`. */
	css: string;
};

/** A version of the Design system as Staff edit it. */
export type EditableDesignSystem = {
	tokens: Tokens;
	classes: EditableClass[];
	/** Declarations per element the base styles style (`BASE_TARGETS`). */
	baseStyles: Record<string, string>;
	/** The Site-wide custom CSS. */
	customCss: string;
	darkMode: boolean;
};

/** Where the Design system stands, as for Templates: never published, published as it is, or changed since. */
export type DesignSystemStatus = "draft" | "published" | "changed";

/** The Site's Design system: its Draft and its published version (null until there is one). */
export type DesignSystemView = {
	status: DesignSystemStatus;
	draft: EditableDesignSystem;
	published: EditableDesignSystem | null;
	/** When the Draft was last saved; null while the Site has never changed it. */
	updatedAt: Date | null;
	publishedAt: Date | null;
	lastPublishedAt: Date | null;
};

type WithOptionalId<T> = Omit<T, "id"> & { id?: string };

/** Tokens to save: a token without an id is new. */
export type TokensInput = Omit<
	Tokens,
	"colours" | "space" | "text" | "fonts" | "radius" | "shadows" | "breakpoints" | "widths"
> & {
	colours: WithOptionalId<ColourToken>[];
	space: Omit<Scale, "steps"> & { steps: WithOptionalId<ScaleStep>[] };
	text: Omit<Scale, "steps"> & { steps: WithOptionalId<ScaleStep>[] };
	fonts: WithOptionalId<FontToken>[];
	radius: WithOptionalId<Tokens["radius"][number]>[];
	shadows: WithOptionalId<ShadowToken>[];
	breakpoints: WithOptionalId<Tokens["breakpoints"][number]>[];
	widths: WithOptionalId<Tokens["widths"][number]>[];
};

/** A Class to save: one without an id is new; CSS left out stays as it is. */
export type ClassInput = {
	id?: string;
	name: string;
	styles?: string;
	breakpoints?: Record<string, string>;
	css?: string;
};

/** A change to the Draft: each section given replaces that section; sections left out stay as they are. */
export type DesignSystemChange = {
	tokens?: TokensInput;
	/** Every Class, in order: Classes left out are deleted (refused while in use). */
	classes?: ClassInput[];
	/** Every base style, by the element it styles. */
	baseStyles?: Record<string, string>;
	customCss?: string;
	darkMode?: boolean;
};

/** A Class to create, or what to change in one. */
export type ClassChange = Omit<ClassInput, "id">;

// ---------------------------------------------------------------------------------------------
// Reading

/** The Site's Design system, Draft and published. */
export async function getDesignSystem(scope: SiteScope): Promise<DesignSystemView> {
	return viewOf(await scope.first(designSystems));
}

function viewOf(row: DesignSystemRow | undefined): DesignSystemView {
	if (!row) {
		return {
			status: "draft",
			draft: editable(defaultDesignSystem()),
			published: null,
			updatedAt: null,
			publishedAt: null,
			lastPublishedAt: null,
		};
	}
	const draft = readDesignSystem(row.draft);
	const published = row.published === null ? null : readDesignSystem(row.published);
	return {
		status: row.publishedAt === null || !published ? "draft" : sameJson(draft, published) ? "published" : "changed",
		draft: editable(draft),
		published: published && editable(published),
		updatedAt: row.updatedAt,
		publishedAt: row.publishedAt,
		lastPublishedAt: row.lastPublishedAt,
	};
}

/** A Design system as Staff edit it, its CSS printed with today's names. */
export function editable(designSystem: DesignSystem): EditableDesignSystem {
	const { print } = designSystemNames(designSystem);
	const text = (css: CssText) => printCss(css, print);
	return {
		tokens: designSystem.tokens,
		classes: designSystem.classes.map((each) => ({
			id: each.id,
			name: each.name,
			generated: each.generated,
			styles: text(each.styles),
			breakpoints: Object.fromEntries(Object.entries(each.breakpoints).map(([id, css]) => [id, text(css)])),
			css: text(each.css),
		})),
		baseStyles: Object.fromEntries(Object.entries(designSystem.baseStyles).map(([target, css]) => [target, text(css)])),
		customCss: text(designSystem.customCss),
		darkMode: designSystem.darkMode,
	};
}

// ---------------------------------------------------------------------------------------------
// Changing

/** Saves a change to the Draft. Visitors see nothing of it until the Design system is published. */
export async function saveDesignSystemDraft(scope: SiteScope, change: DesignSystemChange): Promise<DesignSystemView> {
	return changeDraft(scope, () => change);
}

/** Adds a Class to the Draft, answering it. */
export async function createClass(
	scope: SiteScope,
	input: ClassChange,
): Promise<{ class: EditableClass; designSystem: DesignSystemView }> {
	const designSystem = await changeDraft(scope, (draft) => ({ classes: [...keepClasses(draft), input] }));
	// Class names are unique on the Site.
	const made = designSystem.draft.classes.find((each) => each.name === input.name);
	if (!made) throw new ClassNotFoundError();
	return { class: made, designSystem };
}

/** Renames or restyles a Class of the Draft: its id stays, so every element and CSS using it follows. */
export async function updateClass(
	scope: SiteScope,
	classId: string,
	change: Partial<ClassChange>,
): Promise<{ class: EditableClass; designSystem: DesignSystemView }> {
	const designSystem = await changeDraft(scope, (draft) => {
		const current = draft.classes.find((each) => each.id === classId);
		if (!current) throw new ClassNotFoundError();
		return {
			classes: keepClasses(draft).map((each) =>
				each.id === classId ? { ...each, ...change, name: change.name ?? current.name } : each,
			),
		};
	});
	return { class: classIn(designSystem, classId), designSystem };
}

/** Deletes a Class from the Draft; refused while an element or CSS uses it (`ClassInUseError`). */
export async function deleteClass(scope: SiteScope, classId: string): Promise<DesignSystemView> {
	return changeDraft(scope, (draft) => {
		if (!draft.classes.some((each) => each.id === classId)) throw new ClassNotFoundError();
		return { classes: keepClasses(draft).filter((each) => each.id !== classId) };
	});
}

/**
 * The Design tokens as a DTCG file: the Draft's, or the published ones (the default ones until the
 * Design system is first published).
 */
export async function exportDesignTokens(
	scope: SiteScope,
	version: "draft" | "published",
): Promise<Record<string, unknown>> {
	const row = await scope.first(designSystems);
	const stored = version === "draft" ? row?.draft : row?.published;
	const designSystem = stored ? readDesignSystem(stored) : defaultDesignSystem();
	return exportTokens(designSystem.tokens, `Design tokens of ${scope.site.name}`);
}

/**
 * Imports a DTCG file into the Draft: each kind of token it holds replaces the Draft's, keeping the
 * ids of tokens it names (so their uses stay linked). Refused when the file can't be read
 * (`TokensFileInvalidError`), when its tokens can't be used (`DesignSystemInvalidError`), or when it
 * leaves out a token something uses (`TokenInUseError`).
 */
export async function importDesignTokens(scope: SiteScope, file: unknown): Promise<DesignSystemView> {
	return changeDraft(scope, (draft) => {
		const read = importTokens(file, draft.tokens);
		if ("problems" in read) throw new TokensFileInvalidError(read.problems);
		return { tokens: read.tokens };
	});
}

/** Every Class of the Draft as it is: by id and name, its CSS left out so it stays. */
function keepClasses(draft: DesignSystem): ClassInput[] {
	return draft.classes.map((each) => ({ id: each.id, name: each.name }));
}

function classIn(view: DesignSystemView, classId: string): EditableClass {
	const found = view.draft.classes.find((each) => each.id === classId);
	if (!found) throw new ClassNotFoundError();
	return found;
}

/** Changes the Draft under its lock: works the change out from the Draft, checks it and saves it. */
async function changeDraft(
	scope: SiteScope,
	changeFor: (draft: DesignSystem) => DesignSystemChange,
): Promise<DesignSystemView> {
	return scope.transaction(async (tx) => {
		const locked = await lockDesignSystem(tx);
		const next = applyChange(locked.draft, changeFor(locked.draft));
		await refuseRemovingUsed(tx, locked.draft, next);
		const problems = designSystemProblems(next);
		if (problems.length > 0) throw new DesignSystemInvalidError(problems);
		await writeDraft(tx, locked, next);
		return viewOf({ ...locked.row, draft: next, updatedAt: tx.now() });
	});
}

/**
 * The Draft with a change applied. CSS text is read with the names the change gives (a token or
 * Class renamed in the same save is found by its new name); text equal to what is stored, printed
 * with today's names, keeps the stored references. Throws `DesignSystemInvalidError` with every
 * problem in the CSS.
 */
function applyChange(current: DesignSystem, change: DesignSystemChange): DesignSystem {
	const problems: DesignSystemProblem[] = [];
	const before = designSystemNames(current);
	const tokens = change.tokens ? withTokenIds(change.tokens) : current.tokens;

	const inputs = change.classes;
	const existing = new Map(current.classes.map((each) => [each.id, each]));
	const skeleton: DesignClass[] = inputs
		? inputs.map((input, index) => {
				if (input.id !== undefined && !existing.has(input.id)) {
					problems.push({
						at: `classes[${index}].id`,
						message: "There is no Class with this id: leave the id out for a new Class.",
					});
				}
				return {
					id: input.id ?? crypto.randomUUID(),
					name: input.name,
					generated: false,
					styles: [],
					breakpoints: {},
					css: [],
				};
			})
		: current.classes;
	// Tokens are checked with the rest, after removing one in use is refused with where it is used.
	const names = designSystemNames({ ...current, tokens, classes: skeleton });

	const read = (text: string | undefined, stored: CssText, kind: CssKind, at: string): CssText =>
		readOrKeep(text, stored, kind, at, before, names, problems);

	const classes = inputs
		? skeleton.map((made, index): DesignClass => {
				const input = inputs[index] as ClassInput;
				const old = existing.get(made.id);
				const at = `classes[${index}]`;
				const styles = read(input.styles, old?.styles ?? [], "declarations", `${at}.styles`);
				const css = read(input.css, old?.css ?? [], "nested", `${at}.css`);
				let breakpoints = old?.breakpoints ?? {};
				if (input.breakpoints) {
					breakpoints = {};
					for (const [breakpointId, text] of Object.entries(input.breakpoints)) {
						const stored = old?.breakpoints[breakpointId] ?? [];
						const parsed = read(text, stored, "declarations", `${at}.breakpoints.${breakpointId}`);
						if (parsed.length > 0) breakpoints[breakpointId] = parsed;
					}
				}
				const unchanged =
					old !== undefined &&
					old.name === made.name &&
					styles === old.styles &&
					css === old.css &&
					sameJson(breakpoints, old.breakpoints);
				return { ...made, generated: unchanged && old.generated, styles, breakpoints, css };
			})
		: current.classes;

	let baseStyles = current.baseStyles;
	if (change.baseStyles) {
		baseStyles = {};
		for (const [target, text] of Object.entries(change.baseStyles)) {
			if (!(BASE_TARGETS as readonly string[]).includes(target)) {
				problems.push({ at: `baseStyles.${target}`, message: `Base styles can't style ${target}.` });
				continue;
			}
			const parsed = read(text, current.baseStyles[target] ?? [], "declarations", `baseStyles.${target}`);
			if (parsed.length > 0) baseStyles[target] = parsed;
		}
	}
	const customCss = read(change.customCss, current.customCss, "stylesheet", "customCss");
	if (problems.length > 0) throw new DesignSystemInvalidError(problems);
	return {
		version: 1,
		tokens,
		classes,
		baseStyles,
		customCss,
		darkMode: change.darkMode ?? current.darkMode,
	};
}

/** Text read as stored CSS, or the stored CSS kept when the text is what it prints as now. */
function readOrKeep(
	text: string | undefined,
	stored: CssText,
	kind: CssKind,
	at: string,
	before: DesignSystemNames,
	names: DesignSystemNames,
	problems: DesignSystemProblem[],
): CssText {
	if (text === undefined || text === printCss(stored, before.print)) return stored;
	if (!text.trim()) return [];
	return readCssAt(text, kind, names.css, at, problems);
}

/** Tokens with an id for each new one. */
function withTokenIds(input: TokensInput): Tokens {
	const id = <T extends { id?: string }>(each: T): T & { id: string } => ({
		...each,
		id: each.id ?? crypto.randomUUID(),
	});
	return {
		...input,
		colours: input.colours.map(id),
		space: { ...input.space, steps: input.space.steps.map(id) },
		text: { ...input.text, steps: input.text.steps.map(id) },
		fonts: input.fonts.map(id),
		radius: input.radius.map(id),
		shadows: input.shadows.map(id),
		breakpoints: input.breakpoints.map(id),
		widths: input.widths.map(id),
	};
}

/** Every token's id and name. */
function tokenList(tokens: Tokens): { id: string; name: string }[] {
	return [
		...tokens.colours,
		...tokens.space.steps.map((step) => ({ id: step.id, name: `space-${step.name}` })),
		...tokens.text.steps.map((step) => ({ id: step.id, name: `text-${step.name}` })),
		...tokens.fonts,
		...tokens.radius,
		...tokens.shadows,
		...tokens.breakpoints,
		...tokens.widths,
	];
}

/** Refuses a change that removes a Class or a token something still uses. */
async function refuseRemovingUsed(scope: SiteScope, current: DesignSystem, next: DesignSystem): Promise<void> {
	const kept = new Set(next.classes.map((each) => each.id));
	for (const removed of current.classes.filter((each) => !kept.has(each.id))) {
		const uses = await classUses(scope, next, removed.id);
		if (uses.length > 0) throw new ClassInUseError(removed.id, removed.name, uses);
	}
	const keptTokens = new Set(tokenList(next.tokens).map((each) => each.id));
	for (const removed of tokenList(current.tokens).filter((each) => !keptTokens.has(each.id))) {
		const uses = await tokenUses(scope, next, removed.id);
		if (uses.length > 0) throw new TokenInUseError(removed.id, removed.name, uses);
	}
}
