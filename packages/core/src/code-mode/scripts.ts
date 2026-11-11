/**
 * Code mode's JS panel (ADR 0016): the page's script and the Site script, and the Component script of
 * the Placement selected (its Component tab), saved to their Drafts. A changed script never runs as
 * Staff type: it runs once saved, when Staff press Run (which loads its Draft's file on the page) or
 * load the page again in Code mode.
 */

import { componentLoaderName, contentHash } from "@webcraft/renderer";

import {
	type ComponentScript,
	componentLoaderFile,
	getComponentScript,
	saveComponentScript,
} from "../content/component-scripts.ts";
import { getComponent } from "../content/components.ts";
import { getScript, type Script, type ScriptKind, saveScriptDraft, scriptFile } from "../content/scripts.ts";
import { EditPathInvalidError } from "../edit-mode/errors.ts";
import { CODE_MODE_SCRIPT_PATH, isEditPath } from "../edit-mode/paths.ts";
import { isUuid } from "../ids.ts";
import type { SiteHost, SitePages } from "../site-pages/index.ts";
import { listLibraries } from "../site-scripts/libraries.ts";
import type { ConsentCategory } from "../site-scripts/outside-scripts.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { CodeSourceNotFoundError } from "./errors.ts";
import { findNode, readCodeRef, resolveSource, type SourceDeps } from "./sources.ts";

/** A script as the JS panel shows it: its Draft, its version (null while there is none) and its Draft's file. */
export type CodeScript = { code: string; version: string | null; src: string | null };

/**
 * The Component tab of the JS panel: the Component of the Placement selected, its name, whether Code
 * mode may save its script (a Module's Component has none), on how many published pages it shows (the
 * "used on N pages" warning), and its script's Draft: code, Consent category, the Libraries it
 * declares (with the Site's Libraries to choose from), version and Draft's loader.
 */
export type CodeComponentScript = {
	componentId: string;
	name: string;
	editable: boolean;
	pages: number;
	code: string;
	consentCategory: ConsentCategory;
	libraryIds: string[];
	libraries: { id: string; name: string }[];
	version: string | null;
	src: string | null;
};

/**
 * The page's scripts: the Site script, the page's own (null on a page that shows no Entry, such as
 * the built-in 404 page) and, when the selection is a Placement or inside one, its Component's script.
 */
export type CodeScripts = {
	site: CodeScript;
	page: (CodeScript & { entryId: string }) | null;
	component?: CodeComponentScript | null;
};

function codeScript(script: Script | null): CodeScript {
	if (!script) return { code: "", version: null, src: null };
	return {
		code: script.draft,
		version: script.version,
		src: script.draft.trim() ? `${CODE_MODE_SCRIPT_PATH}${script.version}.js` : null,
	};
}

/** The Entry whose page the path shows, if it shows one. */
async function pageEntry(pages: Pick<SitePages, "pageContent">, host: SiteHost, path: string): Promise<string | null> {
	if (!isEditPath(path)) throw new EditPathInvalidError();
	return (await pages.pageContent(host, path)).entryId;
}

/**
 * The scripts of the page at `path`, as the JS panel shows them; with `ref` (the element selected, as
 * the page tags it), the Component script of its Placement too.
 */
export async function readScripts(
	scope: SiteScope,
	deps: SourceDeps,
	host: SiteHost,
	path: string,
	ref?: string | null,
): Promise<CodeScripts> {
	const entryId = await pageEntry(deps, host, path);
	return {
		site: codeScript(await getScript(scope, null)),
		page: entryId === null ? null : { entryId, ...codeScript(await getScript(scope, entryId)) },
		...(ref === undefined
			? {}
			: { component: ref === null ? null : await selectedComponent(scope, deps, host, path, ref) }),
	};
}

/**
 * The Component whose script the selection shows: the Placement selected (an element of a Template's
 * or Component's markup that is a Placement), else the innermost Placement the selection is inside.
 * Null when the selection is in no Placement.
 */
async function selectedComponent(
	scope: SiteScope,
	deps: SourceDeps,
	host: SiteHost,
	path: string,
	text: string,
): Promise<CodeComponentScript | null> {
	const ref = readCodeRef(text);
	const { source, catalogue } = await resolveSource(scope, deps, host, path, ref);
	const selected = ref.element ? findNode(source.tree.nodes, ref.element)?.node : undefined;
	const componentId =
		selected?.type === "component" ? selected.component : source.kind === "component" ? source.id : null;
	if (componentId === null) return null;
	const editable = isUuid(componentId);
	const script = editable ? await getComponentScript(scope, componentId) : null;
	return {
		componentId,
		name: catalogue.nameOf(componentId) ?? "",
		editable,
		pages: (await getComponent(scope, componentId, deps.sources)).usage.pages,
		...codeComponentScript(script),
		libraries: (await listLibraries(scope)).map((library) => ({ id: library.id, name: library.name })),
	};
}

function codeComponentScript(
	script: ComponentScript | null,
): Pick<CodeComponentScript, "code" | "consentCategory" | "libraryIds" | "version" | "src"> {
	if (!script) return { code: "", consentCategory: "necessary", libraryIds: [], version: null, src: null };
	const hash = contentHash(script.draft.code);
	return {
		...script.draft,
		version: script.version,
		src: script.draft.code.trim() ? `${CODE_MODE_SCRIPT_PATH}${componentLoaderName(script.componentId, hash)}` : null,
	};
}

/**
 * Saves a Component script's Draft from the JS panel's Component tab, based on the version it was
 * opened at (null: there was none yet); its Consent category and Libraries stay as they were unless
 * given. Refused with `DraftChangedError` when someone saved it meanwhile.
 */
export async function saveComponentScriptFromPanel(
	scope: SiteScope,
	deps: SourceDeps,
	input: {
		componentId: string;
		code: string;
		consentCategory?: ConsentCategory;
		libraryIds?: string[];
		version: string | null;
	},
): Promise<CodeComponentScript> {
	const { componentId, version, ...change } = input;
	const script = await saveComponentScript(scope, componentId, change, { basedOn: version });
	return {
		componentId,
		name: (await getComponent(scope, componentId, deps.sources)).component.name,
		editable: true,
		pages: (await getComponent(scope, componentId, deps.sources)).usage.pages,
		...codeComponentScript(script),
		libraries: (await listLibraries(scope)).map((library) => ({ id: library.id, name: library.name })),
	};
}

/**
 * Saves the Site script's Draft or the page's script's Draft, based on the version it was opened at
 * (null: there was none yet); refused with `DraftChangedError` when someone saved it meanwhile.
 */
export async function saveScript(
	scope: SiteScope,
	pages: Pick<SitePages, "pageContent">,
	host: SiteHost,
	input: { path: string; kind: ScriptKind; code: string; version: string | null },
): Promise<CodeScript> {
	const entryId = await pageEntry(pages, host, input.path).then((found) => (input.kind === "site" ? null : found));
	if (input.kind === "page" && entryId === null) throw new CodeSourceNotFoundError();
	return codeScript(await saveScriptDraft(scope, entryId, input.code, { basedOn: input.version }));
}

/**
 * The Draft of one of the Site's scripts by its file's name (`/_webcraft/edit/js/<name>`), or the
 * loader of a Component script's Draft (`component/<id>/<hash>.js`); null for any other name.
 */
export async function draftScript(scope: SiteScope, name: string): Promise<string | null> {
	return (await scriptFile(scope, name, "draft")) ?? (await componentLoaderFile(scope, name, "draft"));
}
