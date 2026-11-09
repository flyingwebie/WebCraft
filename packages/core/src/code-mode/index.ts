/**
 * Code mode (ADR 0016): a third way of using Edit mode, for Staff and the Superadmin. Selecting an
 * element on the page opens the Template or Component it comes from as Template markup, its Class or
 * the Site CSS, and the page's and the Site's scripts, all saved to their Drafts.
 *
 * Every Code mode request comes from a page in Edit mode (the edit cookie, the same-origin check and
 * the header token, as every edit request), and then opens the Site with `structure.edit` through the
 * data layer: Members in Edit mode never get it.
 */
import type { ComponentSources } from "../content/components.ts";
import { draftStyles } from "../design-system/stylesheet.ts";
import type { EditSession } from "../edit-mode/index.ts";
import type { PageContent, SiteHost } from "../site-pages/index.ts";
import type { DataLayer, SiteScope } from "../tenancy/data-layer.ts";
import { PermissionDeniedError, SiteNotFoundError } from "../tenancy/errors.ts";
import { type OpenedSource, openSource, readCodeRef, type SourceDeps } from "./sources.ts";

export { CodeSourceNotFoundError } from "./errors.ts";
export type { CodeSourceKind, OpenedSource, Suggestions } from "./sources.ts";

export type CodeMode = {
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
};

export function createCodeMode(options: {
	data: DataLayer;
	/** Where Modules' Components come from. */
	sources: ComponentSources;
	/** What a page shows from the content store (`SitePages.pageContent`). */
	pageContent(host: SiteHost, pathname: string): Promise<PageContent>;
}): CodeMode {
	const { data } = options;
	const deps: SourceDeps = { sources: options.sources, pageContent: options.pageContent };
	const access = (session: EditSession) => data.site(session.access, session.scope.site.id, "structure.edit");
	return {
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
			const content = await options.pageContent(host, input.path);
			const root = content.templatePostTypeId && !content.notFound ? "content" : "site";
			return openSource(scope, deps, host, input.path, { root, placements: [], element: null });
		},
	};
}
