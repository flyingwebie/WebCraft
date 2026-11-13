import type { Label } from "./manifest.ts";

/**
 * The Field types a Module's Component can declare a Prop with: every Field type but Relationship,
 * since each Site has its own Post Types.
 */
export type ComponentPropType =
	| "text"
	| "richText"
	| "number"
	| "boolean"
	| "date"
	| "select"
	| "media"
	| "link"
	| "email"
	| "group"
	| "repeater";

/**
 * One Prop of a Module's Component, declared as a Field is: its key (how its markup reads it,
 * `props.<key>`), its type and that type's settings. Its label and help text are in each of the
 * Module's admin languages; a select's choice labels are the words visitors see.
 */
export type ComponentProp = {
	/** A lower-case letter, then letters, digits and underscores: `heading`, `heroImage`. Never changes. */
	key: string;
	label: Label;
	type: ComponentPropType;
	help?: Label;
	/** Whether every Placement must give it (unless it has a default). */
	required?: boolean;
	/** Translate human text per Block; settings and references stay shared. */
	translatable?: boolean;
	/** The value a Placement that leaves it out gets, as the APIs take the Field type's value. */
	default?: unknown;
	minLength?: number | null;
	maxLength?: number | null;
	pattern?: string | null;
	min?: number | string | null;
	max?: number | string | null;
	integer?: boolean;
	mode?: "date" | "time" | "dateTime";
	options?: readonly { value: string; label: string }[];
	multiple?: boolean;
	/** A Group's or Repeater's own Fields. */
	fields?: readonly ComponentProp[];
};

/**
 * A Component a Module adds (ADR 0024): declarative, its Props declared with the Field types and its
 * output in Template markup. Staff place it with its tag where the Module runs, like the Site's own
 * Components, and it is published with the Module: Sites can't change it.
 *
 *     components: [
 *       component({
 *         name: "NoteCard",
 *         label: { en: "Note card", it: "Scheda nota" },
 *         props: [{ key: "body", label: { en: "Text", it: "Testo" }, type: "text", required: true }],
 *         markup: "<aside><p>{{ props.body }}</p></aside>",
 *       }),
 *     ],
 */
export type ModuleComponent = {
	/**
	 * Its PascalCase tag in Template markup, such as `NoteCard`: unique among the Install's Modules.
	 * Templates place it by `<module id>:<name>`, so never rename one that shipped.
	 */
	name: string;
	/** What Staff see for it, in each of the Module's admin languages. */
	label: Label;
	props?: readonly ComponentProp[];
	/**
	 * What it shows, as Template markup reading its Props as `props.x`. It reads nothing else (the
	 * Globals differ on every Site), holds no Classes or inline styles, and places no Components.
	 */
	markup: string;
};

/** Declares one of a Module's Components. It only gives the definition back, typed. */
export function component(definition: ModuleComponent): ModuleComponent {
	return definition;
}

/** A declarative Body Block, also reusable as a Component. Stored using the lossless Component
 * Block representation (stable id, namespaced component id, Prop text). Staff explicitly allow
 * its id on a Post Type's Body field before editors can insert it. Added in SDK 1.12. */
export type ModuleBlockType = ModuleComponent;
export function blockType(definition: ModuleBlockType): ModuleBlockType {
	return definition;
}
