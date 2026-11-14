import type { ProcedurePath } from "./catalogue.ts";

/**
 * The procedures of the Management API a Site's own address serves to the building area (ADR 0037),
 * at `/_webcraft/build/api/rpc/…`, for an Edit mode session: nothing else is there.
 *
 * Every one is a Site procedure: it takes `siteId`, which must be the session's own Site, and opens
 * that Site for the person with its usual Permission (`can()`, unchanged). The Site's own scripts and
 * Libraries run beside the shell with the same session, so each line here widens what they can do as
 * the person editing: add a procedure only with a reason and a test in `tests/building-area/` (a
 * Sensitive action, or a Workspace, Install or account procedure that doesn't take the Site, is never
 * served, listed or not).
 * Adding a path that isn't a procedure fails the typecheck.
 */
export const BUILDING_AREA_PROCEDURES = [
	// Content the canvas and the Content place show.
	"postTypes.list",
	"postTypes.get",
	"entries.list",
	"entries.get",
	"entries.create",
	"globals.get",
	// The Content place's Globals form (Members as Staff: `entry.edit`, as in the admin).
	"globals.saveDraft",
	// The Media library: reads and uploads.
	"media.list",
	"media.overview",
	"media.get",
	"media.usage",
	"media.folders.list",
	"media.upload",
	// The Media place and its picker (BA-22): a file's texts, folder and Focal point, Replace file, Import
	// from URL, the folders and the Trash, as the admin's Media screen does them (`media.upload` for
	// one's own uploads, `media.manage` for everyone's and the folders). Moving to the Trash, deleting for
	// good and emptying the Trash each take two calls, the second with the confirmation the first
	// answered, for everyone; Import from URL keeps its guarded fetcher and its limits per person and per
	// Site. Suggest alt text (an AI provider's cost) stays the admin's.
	"media.update",
	"media.replace",
	"media.importUrl",
	"media.delete",
	"media.restore",
	"media.deleteForever",
	"media.emptyTrash",
	"media.folders.create",
	"media.folders.rename",
	"media.folders.delete",
	// The Design system.
	"designSystem.get",
	"designSystem.saveDraft",
	"designSystem.preview",
	"designSystem.createClass",
	"designSystem.updateClass",
	"designSystem.deleteClass",
	"designSystem.exportTokens",
	"designSystem.importTokens",
	"designSystem.exportFile",
	"designSystem.importFile",
	"designSystem.publish",
	// Templates.
	"templates.list",
	"templates.getEntryTemplate",
	"templates.saveEntryTemplate",
	"templates.getEntryTemplateMarkup",
	"templates.saveEntryTemplateMarkup",
	"templates.getSiteTemplate",
	"templates.saveSiteTemplate",
	"templates.getSiteTemplateMarkup",
	"templates.saveSiteTemplateMarkup",
	"templates.getArchiveTemplate",
	"templates.saveArchiveTemplate",
	"templates.getArchiveTemplateMarkup",
	"templates.saveArchiveTemplateMarkup",
	"templates.getSearchTemplate",
	"templates.saveSearchTemplate",
	"templates.getSearchTemplateMarkup",
	"templates.saveSearchTemplateMarkup",
	"templates.publish",
	// Components.
	"components.list",
	"components.get",
	"components.create",
	"components.make",
	"components.saveDraft",
	"components.getMarkup",
	"components.saveMarkup",
	"components.publish",
	"components.getScript",
	"components.saveScriptDraft",
	"components.rename",
	"components.delete",
	// The Builder's services the canvas and the panels use (not the Undo history's hand-over).
	"builder.open",
	"builder.preview",
	"builder.read",
	"builder.markup",
	"builder.css",
	"builder.saveCss",
	"builder.commandMenu",
	"builder.destinations",
	// Loops.
	"loops.list",
	"loops.get",
	"loops.create",
	"loops.saveDraft",
	"loops.saveItems",
	"loops.data",
	"loops.publish",
	// Page layouts, as Members arrange them.
	"pageLayouts.settings",
	"pageLayouts.get",
	"pageLayouts.save",
	// Publish in the bottom bar.
	"publishing.count",
	"publishing.publishAll",
	// The person's own Reviews (sending one back is the reviewer's, in the admin).
	"reviews.list",
	"reviews.get",
	"reviews.count",
	"reviews.submit",
	"reviews.withdraw",
	// Publish later, for one item.
	"publishing.scheduled",
	"publishing.schedule",
	"publishing.reschedule",
	"publishing.cancelScheduled",
	// The person's own editor preferences (panel layout and the rest), read and saved from the shell.
	// They take the Site whose building area asks, and open it with `entry.edit`, so they are pinned
	// like every line here; saving is refused while impersonating, as in the admin.
	"me.editorPreferences",
	"me.saveEditorPreferences",
] as const satisfies readonly ProcedurePath[];

/** A procedure the building area may call on the Site's address. */
export type BuildingAreaProcedure = (typeof BUILDING_AREA_PROCEDURES)[number];
