/**
 * What happened on a Site that a Module can react to. Modules react afterwards, as background jobs
 * (ADR 0024): the change is saved first, and a Module that fails never undoes or blocks it; the
 * failure goes to the Module log. An event reaches a Module only where it is switched on.
 *
 * New events are additions (a minor SDK version); a payload only ever gains fields.
 */
export type ModuleEvents = {
	/**
	 * An Entry was published: its Draft went live. `path` is where visitors find it now, and
	 * `pathChanges` every published path the publish changed (its new slug, a Page that moved and
	 * every Page under it), so a Module can send the old paths on.
	 */
	"entry.published": {
		entryId: string;
		postTypeId: string;
		path: string;
		pathChanges: { entryId: string; language: string; from: string; to: string }[];
	};
	/** An Entry was deleted. */
	"entry.deleted": { entryId: string; postTypeId: string };
	/** A Template was published. */
	"template.published": { templateId: string };
	/** The Site's Globals were published. */
	"globals.published": Record<string, never>;
	/**
	 * A visitor sent one of the Site's Forms and its Submission was kept (never spam), SDK 1.4: which
	 * Form, the path of the page it was sent from (null when the post didn't say) and its language.
	 * Nothing the visitor typed.
	 */
	"form.submitted": { formId: string; formKey: string; page: string | null; language: string };
};

export type ModuleEventName = keyof ModuleEvents;

/** Every event, in the order of `ModuleEvents`. */
export const MODULE_EVENTS = [
	"entry.published",
	"entry.deleted",
	"template.published",
	"globals.published",
	"form.submitted",
] as const satisfies readonly ModuleEventName[];

/** One event as a Module receives it: what happened, on which Site, and when. */
export type ModuleEvent<Name extends ModuleEventName = ModuleEventName> = {
	name: Name;
	siteId: string;
	occurredAt: Date;
	data: ModuleEvents[Name];
};
