/**
 * What happened on a Site that a Module can react to. Modules react afterwards, as background jobs
 * (ADR 0024): the change is saved first, and a Module that fails never undoes or blocks it; the
 * failure goes to the Module log. An event reaches a Module only where it is switched on.
 *
 * New events are additions (a minor SDK version); a payload only ever gains fields.
 */
export type ModuleEvents = {
	/** An Entry was published: its Draft went live. */
	"entry.published": { entryId: string; postTypeId: string };
	/** An Entry was deleted. */
	"entry.deleted": { entryId: string; postTypeId: string };
	/** A Template was published. */
	"template.published": { templateId: string };
	/** The Site's Globals were published. */
	"globals.published": Record<string, never>;
};

export type ModuleEventName = keyof ModuleEvents;

/** Every event, in the order of `ModuleEvents`. */
export const MODULE_EVENTS = [
	"entry.published",
	"entry.deleted",
	"template.published",
	"globals.published",
] as const satisfies readonly ModuleEventName[];

/** One event as a Module receives it: what happened, on which Site, and when. */
export type ModuleEvent<Name extends ModuleEventName = ModuleEventName> = {
	name: Name;
	siteId: string;
	occurredAt: Date;
	data: ModuleEvents[Name];
};
