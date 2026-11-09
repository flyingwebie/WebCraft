/**
 * Code mode (ADR 0016): a third way of using Edit mode, for Staff and the Superadmin. Selecting an
 * element on the page opens the Template or Component it comes from as Template markup, its Class or
 * the Site CSS, and the page's and the Site's scripts, all saved to their Drafts.
 *
 * Every Code mode request comes from a page in Edit mode (the edit cookie, the same-origin check and
 * the header token, as every edit request), and then opens the Site with `structure.edit` through the
 * data layer: Members in Edit mode never get it.
 */
import { draftStyles } from "../design-system/stylesheet.ts";
import type { EditSession } from "../edit-mode/index.ts";
import type { DataLayer, SiteScope } from "../tenancy/data-layer.ts";
import { PermissionDeniedError, SiteNotFoundError } from "../tenancy/errors.ts";

export type CodeMode = {
	/**
	 * Opens the Site of an Edit mode session for Code mode: with `structure.edit`, checked again now.
	 * Throws `PermissionDeniedError` for someone who may not change the Site's Structure.
	 */
	open(session: EditSession): Promise<SiteScope>;
	/** As `open`, but null for someone who may not. */
	openIfAllowed(session: EditSession): Promise<SiteScope | null>;
	/** The stylesheet Code mode's pages link: built from the Design system's Draft and the Drafts of the Site's trees. */
	stylesheet(scope: SiteScope): Promise<string>;
};

export function createCodeMode(options: { data: DataLayer }): CodeMode {
	const { data } = options;
	const open = (session: EditSession) => data.site(session.access, session.scope.site.id, "structure.edit");
	return {
		open,
		async openIfAllowed(session) {
			try {
				return await open(session);
			} catch (error) {
				if (error instanceof PermissionDeniedError || error instanceof SiteNotFoundError) return null;
				throw error;
			}
		},
		async stylesheet(scope) {
			return (await draftStyles(scope)).stylesheet.css;
		},
	};
}
