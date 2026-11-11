/**
 * Code mode (ADR 0016): a third way of using Edit mode, for Staff and the Superadmin. Selecting an
 * element on the page opens the Template or Component it comes from as Template markup, its Class or
 * the Site CSS, and the page's and the Site's scripts, all saved to their Drafts.
 *
 * Every Code mode request comes from a page in Edit mode (the edit cookie, the same-origin check and
 * the header token, as every edit request), and then opens the Site with `structure.edit` through the
 * data layer: Members in Edit mode never get it.
 */
import type { MarkupLocations, MarkupNotice, QualityCheck } from "@webcraft/renderer";

import { type BuilderDraft, type BuilderOpened, type BuilderTarget, createBuilder } from "../builder/index.ts";
import type { ComponentSources } from "../content/components.ts";
import { getEntry } from "../content/entries.ts";
import { loopCatalogue } from "../content/loops.ts";
import { parseDeclaredTree, readPropDeclarations } from "../content/prop-markup.ts";
import type { ScriptKind } from "../content/scripts.ts";
import { classCatalogue } from "../design-system/classes.ts";
import { draftDesignSystem } from "../design-system/design-systems.ts";
import { draftStyles } from "../design-system/stylesheet.ts";
import { EditPathInvalidError } from "../edit-mode/errors.ts";
import type { EditSession } from "../edit-mode/index.ts";
import { isEditPath } from "../edit-mode/paths.ts";
import type { PageEditing, SiteHost, SitePages } from "../site-pages/index.ts";
import type { DataLayer, SiteScope } from "../tenancy/data-layer.ts";
import { PermissionDeniedError, SiteNotFoundError } from "../tenancy/errors.ts";
import { type CodeClass, type CodeCss, type CssTarget, makeClass, readCss, saveCss } from "./css.ts";
import { type MarkupChange, previewMarkup, type SavedMarkup, saveMarkup } from "./markup.ts";
import { type CodeScript, type CodeScripts, draftScript, readScripts, saveScript } from "./scripts.ts";
import { type OpenedSource, openSource, readCodeRef, resolveSource, type SourceDeps } from "./sources.ts";

export type { CodeClass, CodeCss, CssTarget, TokenKind } from "./css.ts";
export { CodeSourceNotFoundError } from "./errors.ts";
export type { MarkupChange, SavedMarkup } from "./markup.ts";
export type { CodeScript, CodeScripts } from "./scripts.ts";
export type { CodeSourceKind, OpenedSource, Suggestions } from "./sources.ts";

/** What a preview answers: the whole page, as Code mode shows it with the unsaved changes, and its stylesheet. */
export type CodePreviewPage = {
	checks: QualityCheck[];
	html: string;
	stylesheet: { hash: string; css: string };
	notices: MarkupNotice[];
};

export type CodeMode = {
	editor(
		scope: SiteScope,
		host: SiteHost,
		input: { path: string; ref: string | null },
	): Promise<{
		opened: BuilderOpened;
		target: BuilderTarget;
		ref: string;
		siteId: string;
		editable: boolean;
		name: string | null;
		pageLayout: { id: string; title: string } | null;
		contentAvailable: boolean;
	}>;
	editorMarkup(
		scope: SiteScope,
		host: SiteHost,
		input: { path: string; ref: string | null; draft: BuilderDraft },
	): Promise<{ markup: string }>;
	editorRead(
		scope: SiteScope,
		host: SiteHost,
		input: { path: string; ref: string | null; markup: string },
	): ReturnType<ReturnType<typeof createBuilder>["read"]>;
	/**
	 * Opens the Site of an Edit mode session for Code mode: with `structure.edit`, checked again now.
	 * Throws `PermissionDeniedError` for someone who may not change the Site's Structure.
	 */
	access(session: EditSession): Promise<SiteScope>;
	/** As `access`, but null for someone who may not. */
	openIfAllowed(session: EditSession): Promise<SiteScope | null>;
	/** The stylesheet Code mode's pages link: built from the Design system's Draft and the Drafts of the Site's trees. */
	stylesheet(scope: SiteScope): Promise<string>;
	/**
	 * Opens what an element of the page at `path` comes from, by the reference the page tags it with
	 * (null: the page's content, else the Site template): its Template or Component as Template
	 * markup, with its version, the breadcrumb, where it is used and what to suggest.
	 */
	open(scope: SiteScope, host: SiteHost, input: { path: string; ref: string | null }): Promise<OpenedSource>;
	/**
	 * The page at `path` as Code mode shows it with unsaved markup in place of its source's Draft
	 * (rendered by the same parser as saving, never saved). `editing` is the page's Code mode
	 * rendering, opened with `structure.edit`. Throws `TemplateMarkupInvalidError` for markup that
	 * doesn't parse.
	 */
	preview(
		host: SiteHost,
		editing: PageEditing,
		input: { path: string; markup?: MarkupChange; css?: { target: CssTarget; text: string } },
	): Promise<CodePreviewPage>;
	/**
	 * Saves markup to the Draft of the Template or Component a reference names, based on the version
	 * it was opened at: refused with `DraftChangedError` when someone saved it meanwhile.
	 */
	save(
		scope: SiteScope,
		host: SiteHost,
		input: { path: string; ref: string; markup: string; version: string | null },
	): Promise<SavedMarkup>;
	/**
	 * What the CSS panel shows for an element: the Classes its editor's shared document gives it now
	 * (`classes`, ids in order), else those of the element a reference names (null: the Site CSS only).
	 */
	css(
		scope: SiteScope,
		host: SiteHost,
		input: { path: string; ref: string | null; classes?: readonly string[] },
	): Promise<CodeCss>;
	/**
	 * Saves CSS (a piece of a Class, or the Site CSS) to the Design system's Draft, based on the
	 * version it was opened at.
	 */
	saveCss(
		scope: SiteScope,
		input: { target: CssTarget; text: string; version: string | null },
	): Promise<{
		text: string;
		version: string;
	}>;
	/** Makes a Class of the Design system's Draft, for a name the HTML panel doesn't know yet. */
	createClass(scope: SiteScope, name: string): Promise<{ class: CodeClass }>;
	/** The scripts of the page at `path`, for the JS panel: the Site script and the page's own. */
	scripts(scope: SiteScope, host: SiteHost, path: string): Promise<CodeScripts>;
	/** Saves the Site script's or the page's script's Draft, based on the version it was opened at. */
	saveScript(
		scope: SiteScope,
		host: SiteHost,
		input: { path: string; kind: ScriptKind; code: string; version: string | null },
	): Promise<CodeScript>;
	/** The Draft of one of the Site's scripts by its file's name, as Code mode's pages load it; null for any other. */
	draftScript(scope: SiteScope, name: string): Promise<string | null>;
};

export function createCodeMode(options: {
	data: DataLayer;
	/** Where Modules' Components come from. */
	sources: ComponentSources;
	/** The Site's pages, as the Site pipeline renders them. */
	pages: Pick<SitePages, "render" | "notFound" | "pageContent">;
}): CodeMode {
	const { data, pages } = options;
	const deps: SourceDeps = { sources: options.sources, pageContent: (host, path) => pages.pageContent(host, path) };
	const builder = createBuilder({ sources: options.sources });
	const editorSource = async (scope: SiteScope, host: SiteHost, input: { path: string; ref: string | null }) => {
		const opened = await (input.ref === null
			? pages.pageContent(host, input.path).then((content) =>
					openSource(scope, deps, host, input.path, {
						root: content.templatePostTypeId && !content.notFound ? "content" : "site",
						placements: [],
						element: null,
					}),
				)
			: openSource(scope, deps, host, input.path, readCodeRef(input.ref)));
		const { source, catalogue } = await resolveSource(scope, deps, host, input.path, readCodeRef(opened.ref));
		const target: BuilderTarget =
			source.kind === "component"
				? { kind: "component", componentId: source.id ?? "" }
				: source.kind === "entryTemplate"
					? { kind: "entryTemplate", postTypeId: source.postTypeId ?? "" }
					: { kind: "siteTemplate" };
		return { target, ref: opened.ref, source, catalogue, usage: opened.usage };
	};
	const access = (session: EditSession) => data.site(session.access, session.scope.site.id, "structure.edit");
	return {
		async editor(scope, host, input) {
			const { target, ref, source, catalogue, usage } = await editorSource(scope, host, input);
			const opened = await builder.open(scope, source.editable ? target : { kind: "siteTemplate" });
			const content = ref === "site" ? await pages.pageContent(host, input.path) : null;
			const page =
				content?.entryId && !content.templatePostTypeId && !content.notFound
					? await getEntry(scope, content.entryId, content.language)
					: null;
			return {
				target,
				ref,
				siteId: scope.site.id,
				editable: source.editable,
				name: source.name,
				contentAvailable: !!content?.templatePostTypeId && !content.notFound,
				pageLayout: page ? { id: page.id, title: page.draft.title } : null,
				opened: source.editable
					? { ...opened, tree: opened.template || opened.component ? opened.tree : source.tree }
					: {
							...opened,
							template: null,
							component: null,
							tree: source.tree,
							props: source.id ? (catalogue.version(source.id)?.props ?? null) : null,
							usage,
						},
			};
		},
		async editorMarkup(scope, host, input) {
			return builder.markup(scope, (await editorSource(scope, host, input)).target, input.draft);
		},
		async editorRead(scope, host, input) {
			const { target, source, catalogue } = await editorSource(scope, host, input);
			if (source.editable) return builder.read(scope, target, { markup: input.markup });
			// Module markup can be located without opening (or granting) a writable Module Draft.
			const declarations = readPropDeclarations(input.markup);
			const classes = classCatalogue(await draftDesignSystem(scope));
			let locations: MarkupLocations = {};
			const parsed = parseDeclaredTree(declarations, {
				classNamed: classes.named,
				components: catalogue,
				forms: catalogue.forms,
				popups: catalogue.popups,
				filters: catalogue.filters,
				loops: await loopCatalogue(scope, "draft"),
				locate(found) {
					const prefix = input.markup.replace(/\r\n?/g, "\n").length - declarations.markup.length;
					locations = Object.fromEntries(
						Object.entries(found).map(([key, range]) => [
							key,
							{
								start: range.start + prefix,
								end: range.end + prefix,
							},
						]),
					);
				},
			});
			return {
				...parsed,
				locations,
				styles: {},
				props: source.id ? (catalogue.version(source.id)?.props ?? null) : null,
			};
		},
		access,
		async openIfAllowed(session) {
			try {
				return await access(session);
			} catch (error) {
				if (error instanceof PermissionDeniedError || error instanceof SiteNotFoundError) return null;
				throw error;
			}
		},
		async stylesheet(scope) {
			return (await draftStyles(scope)).stylesheet.css;
		},
		async open(scope, host, input) {
			if (input.ref !== null) return openSource(scope, deps, host, input.path, readCodeRef(input.ref));
			// The page's content first, when a Template renders it; else the Site template around it.
			const content = await pages.pageContent(host, input.path);
			const root = content.templatePostTypeId && !content.notFound ? "content" : "site";
			return openSource(scope, deps, host, input.path, { root, placements: [], element: null });
		},
		async preview(host, editing, input) {
			if (!isEditPath(input.path)) throw new EditPathInvalidError();
			const { preview, notices } = await previewMarkup(editing.scope, deps, host, input.path, input.markup, input.css);
			const shown: PageEditing = { ...editing, code: true, preview };
			let answer = await pages.render(host, input.path, shown);
			// The home page's own path shows the home page.
			if (answer?.kind === "redirect") answer = await pages.render(host, answer.location, shown);
			const page = answer?.kind === "page" ? answer : await pages.notFound(host, input.path, shown);
			return {
				html: page.html,
				checks: page.checks ?? [],
				stylesheet: { hash: preview.styles.stylesheet.hash, css: preview.styles.stylesheet.css },
				notices,
			};
		},
		save: (scope, host, input) => saveMarkup(scope, deps, host, input),
		css: (scope, host, input) => readCss(scope, deps, host, input),
		saveCss: (scope, input) => saveCss(scope, input),
		createClass: (scope, name) => makeClass(scope, name),
		scripts: (scope, host, path) => readScripts(scope, pages, host, path),
		saveScript: (scope, host, input) => saveScript(scope, pages, host, input),
		draftScript,
	};
}
