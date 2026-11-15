import type { FieldDefinition } from "@webcraft/core";
import { type DraftClient, type Json, sameValue } from "@webcraft/core/draft-document";

import { editorHistory } from "../../builder/editor-history.ts";
import { type DocumentValues, writeField } from "../../co-editing/values.ts";
import type { Json as FieldJson } from "../../content/model.ts";
import { draftLayout } from "../../page-layouts/props-input.ts";
import { fill, type Words } from "../api.ts";
import { draftResource, type PageDrafts } from "./drafts.ts";
import type { LayoutInfo, LayoutPlacement } from "./selection.ts";

/**
 * A Page's Page layout as Staff arrange it in the building area (BA-09; ADR 0037 › 1.5): its
 * Placements moved, hidden, duplicated and deleted from the Layers panel, and their Props' values
 * changed in the Props panel. Each is one change of the Page's shared Draft (its Entry's `layout`,
 * Co-editing, ADR 0025), made through the shell's one copy of it (`drafts.ts`, which text typed in place
 * uses too: a second socket would show the person to themselves as someone else), and recorded as one
 * step of the tab's Undo history, taken back through the same copy. The server checks
 * every Page layout it saves (`writePageLayout`): only the Component's own Props, locks for Members.
 *
 * The rules of what may move where are the Page layout controller's (`ui/page-layouts/controller.ts`,
 * the editing bar's): nothing while the person may not arrange; a locked Placement, and moving past
 * one, only for those who may lock (Staff); no row to move to at either end. The controller itself is
 * bound to the editing bar's kit and DOM, so this module keeps its rules and writes through the
 * Page's shared Draft instead of its `layout/save` request.
 */
export type PageLayoutEditor = {
	/** The page in the frame is this Page (its Page layout's state), or none. */
	page(info: LayoutInfo | null): void;
	/** Moves a Placement to a position among the Page layout's Placements. Answers why not, or null. */
	move(placements: readonly LayoutPlacement[], id: string, to: number): string | null;
	/** Hides or shows a Placement on the page. */
	hide(placements: readonly LayoutPlacement[], id: string): string | null;
	/** Places a copy of a Placement after it: answers the copy's id, or why not. */
	duplicate(placements: readonly LayoutPlacement[], id: string): { id: string } | { refused: string };
	/** Deletes a Placement from the page. */
	remove(placements: readonly LayoutPlacement[], id: string): string | null;
	/** Changes one of a Placement's Props' values (in the page's language). */
	setValue(placements: readonly LayoutPlacement[], id: string, field: FieldDefinition, value: FieldJson): string | null;
	/**
	 * Places a Component on the Page (BA-10: the insert row, the Command menu's Insert, the empty Page),
	 * at `at` among the Page layout's Placements (its end when past it), with its Props' declarations and
	 * no values yet: one Undo step, `label`. Answers the new Placement's id, or why not.
	 */
	place(
		placements: readonly LayoutPlacement[],
		component: { id: string; props: FieldDefinition[] },
		at: number,
		label: string,
	): { id: string } | { refused: string };
	destroy(): void;
};

/** Why an action on a Placement is refused, in the controller's terms (`LayoutRefusal`). */
type Refusal = "unavailable" | "locked" | "besideLocked" | "edge";

/** How long a change waits for its Draft to save before the page is drawn again anyway, in milliseconds. */
const SAVE_WAIT_MS = 10_000;

/** A Placement in the Draft's document: its values as the document keeps them (by key and language). */
type DraftPlacement = {
	id: string;
	component: string;
	props: Json;
	hidden?: boolean;
	locked?: boolean;
	values: DocumentValues;
};

export function pageLayoutEditor(options: {
	siteId: string;
	/** The page's shared Drafts: the Page's Entry's is changed through them. */
	drafts: PageDrafts;
	words: Words;
	announce(text: string, urgent?: boolean): void;
	/** The Page layout changed (the person's change saved, someone else's, a step taken back): read it and draw the page again. */
	changed(): void;
	/** A change of the person's didn't save: the Draft state says so. */
	failed(): void;
}): PageLayoutEditor {
	const said = options.words.placements;
	let info: LayoutInfo | null = null;
	/** The Page layout as this tab last saw it in the Draft: a change from elsewhere differs from it. */
	let seen: Json = null;
	/** Whether the person's own change is on its way: the Draft's echo of it isn't someone else's. */
	let own = false;

	const layoutOf = (draft: Json): Json => ((draft as { layout?: Json } | null)?.layout ?? null) as Json;
	const item = () => (info ? `entry:${info.entryId}` : null);

	// Someone else's change to the Page layout, or one of the person's steps taken back: read and drawn again.
	const stopListening = options.drafts.onChange((changedItem, draft) => {
		if (changedItem !== item()) return;
		const layout = layoutOf(draft);
		if (sameValue(layout, seen)) return;
		seen = layout;
		if (own) return;
		// A step taken back is saved like any change: the page is drawn again once the Draft has it
		// (someone else's change has been saved already).
		const client = options.drafts.client(changedItem);
		if (client) void saved(client).then(() => options.changed());
		else options.changed();
	});

	/** Waits until the Draft has saved what was sent (or can't): true when it has. */
	const saved = async (client: DraftClient): Promise<boolean> => {
		client.flush();
		const started = Date.now();
		while (Date.now() - started < SAVE_WAIT_MS) {
			const status = client.status();
			if (status === "saved") return true;
			if (status !== "saving" && status !== "connecting") return false;
			await new Promise((resolve) => setTimeout(resolve, 40));
		}
		return false;
	};

	const refusal = (
		placements: readonly LayoutPlacement[],
		id: string,
		action: "move" | "hide" | "duplicate" | "remove" | "value",
		to?: number,
	): Refusal | null => {
		const at = placements.findIndex((each) => each.id === id);
		const placement = placements[at];
		if (!info?.canArrange || !placement) return "unavailable";
		if (action === "duplicate" || action === "value") return null;
		if (placement.locked && !info.canLock) return "locked";
		if (action !== "move" || to === undefined) return null;
		if (to < 0 || to >= placements.length || to === at) return "edge";
		const passed = placements.slice(Math.min(at, to), Math.max(at, to) + 1);
		return info.canLock || !passed.some((each) => each !== placement && each.locked) ? null : "besideLocked";
	};

	const reason = (refused: Refusal, name: string) => fill(said.layoutRefusals[refused], { name });

	/**
	 * Changes the Page layout in the Draft (one Undo step, `label`): `change` makes the new list of
	 * Placements from the Draft's. Answers why not, or null.
	 */
	const write = (
		label: string,
		ref: string,
		change: (placements: DraftPlacement[]) => DraftPlacement[] | null,
	): string | null => {
		const at = item();
		const client = at ? options.drafts.client(at) : null;
		const status = client?.status();
		if (!at || !client || (status !== "saved" && status !== "saving" && status !== "offline")) return said.connecting;
		const before = client.draft();
		const placements = draftLayout(before).placements as unknown as DraftPlacement[];
		const next = change(structuredClone(placements));
		if (!next) return said.connecting;
		const after = { ...(before as Record<string, Json>), layout: { placements: next } as unknown as Json };
		own = true;
		const changed = client.change(after);
		own = false;
		if (!changed) return said.connecting;
		seen = layoutOf(client.draft());
		const resource = draftResource(options.siteId, at);
		editorHistory().record({
			resource,
			before,
			after: client.draft(),
			label,
			location: { siteId: options.siteId, draft: resource, panel: "tree", ref, selection: null, title: label },
		});
		options.announce(label);
		void saved(client).then((ok) => {
			if (!ok) {
				options.failed();
				options.announce(said.notSaved, true);
			}
			options.changed();
		});
		return null;
	};

	const nameOf = (placements: readonly LayoutPlacement[], id: string) =>
		placements.find((each) => each.id === id)?.name ?? said.placement;

	return {
		page(next) {
			if (next?.entryId !== info?.entryId) seen = null;
			info = next;
		},
		move(placements, id, to) {
			const name = nameOf(placements, id);
			const refused = refusal(placements, id, "move", to);
			if (refused) return reason(refused, name);
			return write(fill(said.steps.move, { name }), `content/${id}`, (list) => {
				const from = list.findIndex((each) => each.id === id);
				const [moving] = from < 0 ? [] : list.splice(from, 1);
				if (!moving) return null;
				list.splice(Math.max(0, Math.min(to, list.length)), 0, moving);
				return list;
			});
		},
		hide(placements, id) {
			const name = nameOf(placements, id);
			const refused = refusal(placements, id, "hide");
			if (refused) return reason(refused, name);
			const hidden = !placements.find((each) => each.id === id)?.hidden;
			return write(fill(hidden ? said.steps.hide : said.steps.show, { name }), `content/${id}`, (list) =>
				list.map((each) => {
					if (each.id !== id) return each;
					const { hidden: _, ...rest } = each;
					return hidden ? { ...rest, hidden: true } : rest;
				}),
			);
		},
		duplicate(placements, id) {
			const name = nameOf(placements, id);
			const refused = refusal(placements, id, "duplicate");
			if (refused) return { refused: reason(refused, name) };
			const copy = crypto.randomUUID();
			const problem = write(fill(said.steps.duplicate, { name }), `content/${copy}`, (list) => {
				const at = list.findIndex((each) => each.id === id);
				const original = list[at];
				if (!original) return null;
				const { locked: _, ...rest } = structuredClone(original);
				list.splice(at + 1, 0, { ...rest, id: copy });
				return list;
			});
			return problem ? { refused: problem } : { id: copy };
		},
		remove(placements, id) {
			const name = nameOf(placements, id);
			const refused = refusal(placements, id, "remove");
			if (refused) return reason(refused, name);
			return write(fill(said.steps.remove, { name }), `content/${id}`, (list) => list.filter((each) => each.id !== id));
		},
		setValue(placements, id, field, value) {
			const name = nameOf(placements, id);
			const refused = refusal(placements, id, "value");
			if (refused || !info) return reason(refused ?? "unavailable", name);
			const languages = { language: info.language, defaultLanguage: info.defaultLanguage };
			return write(fill(said.steps.prop, { name, prop: field.label || field.key }), `content/${id}`, (list) =>
				list.map((each) =>
					each.id === id ? { ...each, values: writeField(each.values ?? {}, field, value, languages) } : each,
				),
			);
		},
		place(_placements, component, at, label) {
			// The server checks what a Member may place (Allowed components, locks) as it saves the Draft.
			if (!info?.canArrange) return { refused: reason("unavailable", said.placement) };
			const id = crypto.randomUUID();
			const problem = write(label, `content/${id}`, (list) => {
				list.splice(Math.max(0, Math.min(at, list.length)), 0, {
					id,
					component: component.id,
					props: component.props as unknown as Json,
					values: {},
				});
				return list;
			});
			return problem ? { refused: problem } : { id };
		},
		destroy: stopListening,
	};
}
