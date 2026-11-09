/**
 * Code mode's JS panel (ADR 0016): the page's script and the Site script, saved to their Drafts. A
 * changed script never runs as Staff type: it runs once saved, when Staff press Run (which loads its
 * Draft's file on the page) or load the page again in Code mode.
 */

import { getScript, type Script, type ScriptKind, saveScriptDraft, scriptFile } from "../content/scripts.ts";
import { CODE_MODE_SCRIPT_PATH } from "../edit-mode/paths.ts";
import type { SiteHost, SitePages } from "../site-pages/index.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { CodeSourceNotFoundError } from "./errors.ts";

/** A script as the JS panel shows it: its Draft, its version (null while there is none) and its Draft's file. */
export type CodeScript = { code: string; version: string | null; src: string | null };

/** The page's scripts: the Site script, and the page's own (null on a page that shows no Entry, such as the built-in 404 page). */
export type CodeScripts = { site: CodeScript; page: (CodeScript & { entryId: string }) | null };

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
	return (await pages.pageContent(host, path)).entryId;
}

/** The scripts of the page at `path`, as the JS panel shows them. */
export async function readScripts(
	scope: SiteScope,
	pages: Pick<SitePages, "pageContent">,
	host: SiteHost,
	path: string,
): Promise<CodeScripts> {
	const entryId = await pageEntry(pages, host, path);
	return {
		site: codeScript(await getScript(scope, null)),
		page: entryId === null ? null : { entryId, ...codeScript(await getScript(scope, entryId)) },
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
	const entryId = input.kind === "site" ? null : await pageEntry(pages, host, input.path);
	if (input.kind === "page" && entryId === null) throw new CodeSourceNotFoundError();
	return codeScript(await saveScriptDraft(scope, entryId, input.code, { basedOn: input.version }));
}

/** The Draft of one of the Site's scripts by its file's name (`/_webcraft/edit/js/<name>`); null for any other name. */
export function draftScript(scope: SiteScope, name: string): Promise<string | null> {
	return scriptFile(scope, name, "draft");
}
