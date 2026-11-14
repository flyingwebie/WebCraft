import type { ProcedurePath } from "./catalogue.ts";

/**
 * The procedures of the Management API a Site's own address serves to the building area (ADR 0037),
 * at `/_webcraft/build/api/rpc/…`, for an Edit mode session: nothing else is there.
 *
 * Every one is a Site procedure: it takes `siteId`, which must be the session's own Site, and opens
 * that Site for the person with its usual Permission (`can()`, unchanged). The Site's own scripts and
 * Libraries run beside the shell with the same session, so each line here widens what they can do as
 * the person editing: add a procedure only with a reason and a test in `tests/building-area/` (a
 * Sensitive action, a Workspace, Install or account procedure is never served, listed or not).
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
	// The Media library: reads and uploads.
	"media.list",
	"media.overview",
	"media.get",
	"media.usage",
	"media.folders.list",
	"media.upload",
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
] as const satisfies readonly ProcedurePath[];

/** A procedure the building area may call on the Site's address. */
export type BuildingAreaProcedure = (typeof BUILDING_AREA_PROCEDURES)[number];
