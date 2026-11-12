import type { ApiClient } from "@webcraft/api";
import type { FieldDefinition, Json } from "@webcraft/core";
import { type Json as DocumentJson, sameValue } from "@webcraft/core/draft-document";
import type { BarKit } from "../../site/edit-bar/kit.ts";
import { editorAccessibility } from "../builder/editor-accessibility.ts";
import { readFieldValues } from "../co-editing/values.ts";

import { draftLayout, propsInput } from "./props-input.ts";

export type LayoutState = Awaited<ReturnType<ApiClient["pageLayouts"]["get"]>>;
export type LayoutAction = "moveUp" | "moveDown" | "duplicate" | "delete" | "hide" | "lock";
export type LayoutPanel = "tree" | "inspector" | "picker" | null;
export type LayoutStep = {
	/** Captured synchronously at the shared-document mutation, before awaiting acknowledgement. */
	draft?: { before: DocumentJson; after: DocumentJson };
	before: LayoutState["layout"];
	after: LayoutState["layout"];
	label: string;
	selection: string | null;
	panel: LayoutPanel;
};

/** One Member selection and mutation owner. Commands and history subscribe; neither owns another Draft. */
export function pageLayoutController(kit: BarKit, initial: LayoutState, entryId: string) {
	let state = initial;
	let selected: string | null = null;
	let panel: LayoutPanel = null;
	let focusRequest = 0;
	let grabbed: LayoutState["layout"] | null = null;
	let queued = 0;
	let busy = false;
	let disposed = false;
	let paint = 0;
	let saved = true;
	let pending: Promise<unknown> = Promise.resolve();
	const listeners = new Set<() => void>();
	const finished = new Set<(step: LayoutStep) => void>();
	const began = new Set<() => () => void>();
	type PropsInput = NonNullable<ReturnType<typeof propsInput>>;
	const inputs = new Map<string, PropsInput>();
	const inlineInputs = new Set<PropsInput>();
	const inputFor = (id: string) => {
		let input = inputs.get(id);
		if (!input) {
			const shared = kit.shared(`entry:${entryId}`);
			input = shared?.ready() ? (propsInput(shared, id, state) ?? undefined) : undefined;
			if (input) inputs.set(id, input);
		}
		return input;
	};
	const flushers = new Set<() => void>();
	const emit = () => {
		for (const listener of listeners) listener();
	};
	const announce = (text: string, refused = false) =>
		editorAccessibility(kit.doc).announce(text, refused ? "interrupt" : "polite");
	const selection = () => state.layout.placements.find((p) => p.id === selected);
	const canEdit = () => state.canArrange && kit.editing() && !disposed;
	const allowed = (action: LayoutAction, id = selected, duringSave = false) => {
		const p = state.layout.placements.find((p) => p.id === id);
		if (!canEdit() || !p || (busy && !duringSave)) return false;
		if (action === "lock") return state.canLock;
		if (action === "duplicate") return state.components.some((c) => c.id === p.component);
		if (p.locked && !state.canLock) return false;
		if (action === "moveUp" || action === "moveDown") {
			const neighbour = state.layout.placements[state.layout.placements.indexOf(p) + (action === "moveUp" ? -1 : 1)];
			return !!neighbour && (state.canLock || !neighbour.locked);
		}
		return true;
	};
	const values = (id: string) => {
		const input = inputFor(id);
		if (input) return input.values();
		const p = state.layout.placements.find((p) => p.id === id);
		return p ? readFieldValues(p.values as Record<string, DocumentJson>, p.props, state) : {};
	};
	const label = (id: string) => state.placements.find((p) => p.id === id)?.label ?? "";
	function range(doc: Document): Range | null {
		const comments = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
		let start: Node | null = null;
		for (let node = comments.nextNode(); node; node = comments.nextNode()) {
			if (node.nodeValue === "wc-page-layout-start") start = node;
			if (node.nodeValue === "wc-page-layout-end" && start) {
				const range = doc.createRange();
				range.setStartAfter(start);
				range.setEndBefore(node);
				return range;
			}
		}
		return null;
	}
	async function refreshPage() {
		const revision = ++paint;
		const fresh = await kit.freshPage();
		if (!fresh || revision !== paint || !canEdit()) return;
		const current = range(kit.doc);
		const replacement = range(fresh);
		if (
			!current ||
			!replacement ||
			(kit.doc.activeElement &&
				current.intersectsNode(kit.doc.activeElement) &&
				kit.doc.activeElement.closest("[contenteditable=true]"))
		)
			return;
		const fragment = kit.doc.importNode(replacement.cloneContents(), true);
		const nodes = [...fragment.childNodes];
		current.deleteContents();
		current.insertNode(fragment);
		kit.adopt(nodes);
		attachInline();
		outline();
		await loadScripts(fresh);
	}
	async function loadScripts(fresh: Document) {
		// Only server-rendered published assets. Existing Code mode script/version owners stay intact.
		for (const source of fresh.querySelectorAll<HTMLScriptElement>(
			"script[data-wc-library],script[data-wc-watch],script[data-wc-component-script]",
		)) {
			const src = source.getAttribute("src");
			if (!src) continue;
			const id = source.dataset.wcComponentScript;
			if (
				[...kit.doc.querySelectorAll<HTMLScriptElement>("script[src]")].some(
					(tag) => tag.getAttribute("src") === src || (id && tag.dataset.wcComponentScript === id),
				)
			)
				continue;
			const tag = kit.doc.createElement("script");
			for (const attribute of source.attributes) tag.setAttribute(attribute.name, attribute.value);
			tag.async = false;
			await new Promise<void>((resolve) => {
				const done = () => {
					clearTimeout(timer);
					resolve();
				};
				const timer = setTimeout(done, 10000);
				tag.addEventListener("load", done, { once: true });
				tag.addEventListener("error", done, { once: true });
				kit.doc.head.append(tag);
			});
		}
	}
	async function reload() {
		const result = await kit.call("layout/get", { entryId, language: kit.state().language.code });
		if (result.ok) {
			state = result.data as LayoutState;
			// A peer deletion can unmount the field without a blur event. Finish/refuse its own input
			// before the UI unregisters the flusher; never leave an orphan capable of restoring the row.
			for (const id of inputs.keys()) if (!state.layout.placements.some((p) => p.id === id)) flushProps(id);
			if (selected && !selection()) selected = null;
			emit();
			outline();
		}
	}
	/** `own` work is the person's action: its place among their steps is kept from this moment. */
	function enqueue(work: () => Promise<unknown>, own = false) {
		queued++;
		const ends = own ? [...began].map((begin) => begin()) : [];
		const next = pending.then(work).finally(() => {
			queued--;
			for (const end of ends) end();
		});
		pending = next.catch(() => {
			saved = false;
			announce(kit.errorText("generic"), true);
		});
		return pending;
	}
	async function save(
		next: LayoutState["layout"],
		title: string,
		before = state.layout,
		options: { record?: boolean; focus?: boolean; announce?: boolean } = {},
	) {
		if (sameValue(before, next)) return true;
		busy = true;
		emit();
		const result = await kit.call("layout/save", {
			entryId,
			language: state.language,
			layout: next,
			basedOn: state.version,
		});
		busy = false;
		saved = result.ok;
		if (!result.ok) {
			announce(kit.errorText(result.code), true);
			await reload();
			emit();
			return false;
		}
		state = result.data as LayoutState;
		if (options.focus) focusRequest++;
		if (options.record !== false)
			for (const listener of finished)
				listener({ before, after: state.layout, label: title, selection: selected, panel });
		emit();
		outline();
		if (options.announce !== false) announce(title);
		await kit.refresh();
		await refreshPage();
		return true;
	}
	function outline() {
		kit.doc.documentElement.classList.toggle("wc-arrange-on", canEdit());
		for (const el of kit.doc.querySelectorAll<HTMLElement>("[data-wc-page-placement]"))
			el.toggleAttribute("data-wc-placement-selected", el.dataset.wcPagePlacement === selected && kit.editing());
	}
	function select(id: string | null, options: { reveal?: boolean; focus?: boolean } = {}) {
		if (id !== selected) {
			for (const flush of flushers) flush();
			if (grabbed) void grab("drop");
		}
		selected = id;
		if (options.reveal) panel = "tree";
		if (options.focus) focusRequest++;
		outline();
		if (id) kit.doc.querySelector(`[data-wc-page-placement="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
		emit();
	}
	async function action(action: LayoutAction, id = selected) {
		if (!allowed(action, id)) return;
		return enqueue(async () => {
			if (!allowed(action, id, true)) return;
			if (action !== "moveUp" && action !== "moveDown") finishGrab();
			const next = structuredClone(state.layout);
			const index = next.placements.findIndex((p) => p.id === id);
			const p = next.placements[index];
			if (!p) return;
			const title = label(p.id);
			if (action === "moveUp" || action === "moveDown") {
				next.placements.splice(index, 1);
				next.placements.splice(index + (action === "moveUp" ? -1 : 1), 0, p);
			}
			if (action === "hide") p.hidden = !p.hidden;
			if (action === "lock") p.locked = !p.locked;
			if (action === "delete") {
				next.placements.splice(index, 1);
				selected = (next.placements[index] ?? next.placements[index - 1])?.id ?? null;
				focusRequest++;
			}
			if (action === "duplicate") {
				const copy = { ...structuredClone(p), id: crypto.randomUUID(), locked: false };
				next.placements.splice(index + 1, 0, copy);
				selected = copy.id;
				focusRequest++;
			}
			if (grabbed && (action === "moveUp" || action === "moveDown")) {
				await save(next, kit.word("pageLayout.move"), state.layout, { record: false, focus: true });
				announce(`${title}, ${next.placements.findIndex((p) => p.id === selected) + 1} / ${next.placements.length}`);
			} else
				await save(next, `${kit.word(`pageLayout.${action}`)} ${title}`, state.layout, {
					focus: action === "moveUp" || action === "moveDown" || action === "duplicate" || action === "delete",
				});
		}, true);
	}
	async function insert(componentId: string) {
		if (!canEdit() || busy) return;
		return enqueue(async () => {
			const component = state.components.find((c) => c.id === componentId);
			if (!component) return;
			finishGrab();
			const p = { id: crypto.randomUUID(), component: componentId, props: component.props, values: {} };
			const next = structuredClone(state.layout);
			const at = next.placements.findIndex((p) => p.id === selected);
			const position = selected === "context:header" ? 0 : at >= 0 ? at + 1 : next.placements.length;
			next.placements.splice(position, 0, p);
			selected = p.id;
			panel = "tree";
			// Focus waits for the save: only then does the tree hold the new row. Asked for sooner, it
			// lands on another row, which selects that one instead.
			await save(next, `${kit.word("pageLayout.add")} ${component.name}`, state.layout, { focus: true });
		}, true);
	}

	function flushProps(id: string) {
		const input = inputs.get(id);
		if (!input) return;
		inputs.delete(id);
		return finishInput(id, input);
	}
	function finishInput(id: string, input: PropsInput) {
		const shared = kit.shared(`entry:${entryId}`);
		const receipt = canEdit() ? input.commit() : null;
		if (!receipt || !shared) {
			input.cancel();
			saved = false;
			announce(kit.errorText("CHANGED_MEANWHILE"), true);
			emit();
			return;
		}
		if ("empty" in receipt || sameValue(receipt.before, receipt.after)) return;
		// This is the own mutation, including the peer state already merged before it. Never infer it
		// from the canonical GET after awaiting the server: that may contain later peer work.
		const step: LayoutStep = {
			before: draftLayout(receipt.before),
			after: draftLayout(receipt.after),
			draft: receipt,
			label: `${kit.word("pageLayout.props")} ${label(id)}`,
			selection: selected,
			panel,
		};
		return enqueue(async () => {
			finishGrab();
			busy = true;
			emit();
			saved = await shared.saved();
			busy = false;
			if (saved) for (const listener of finished) listener(step);
			else announce(kit.errorText("CHANGED_MEANWHILE"), true);
			await reload();
			await kit.refresh();
			await refreshPage();
		}, true);
	}
	function prop(id: string, field: FieldDefinition, value: Json, defer = false) {
		if (!canEdit()) return;
		const input = inputFor(id);
		if (!input?.change(field, value)) {
			saved = false;
			announce(kit.errorText("CHANGED_MEANWHILE"), true);
			return;
		}
		emit();
		if (!defer) return flushProps(id);
	}

	function attachInline() {
		for (const el of kit.doc.querySelectorAll<HTMLElement>("[data-wc-placement-prop]")) {
			const p = state.layout.placements.find((p) => p.id === el.dataset.wcPlacement);
			const f = p?.props.find((f) => f.key === el.dataset.wcPlacementProp && f.type === "text");
			if (!p || !f) continue;
			if (!canEdit()) {
				el.removeAttribute("contenteditable");
				continue;
			}
			el.contentEditable = "true";
			el.spellcheck = true;
			el.setAttribute("role", "textbox");
			el.setAttribute("aria-label", f.label);
			if (el.dataset.wcPropReady) continue;
			el.dataset.wcPropReady = "true";
			let before = el.textContent ?? "";
			let input: PropsInput | null = null;
			el.addEventListener("focus", () => {
				before = el.textContent ?? "";
				select(p.id);
				if (input) {
					input.cancel();
					inlineInputs.delete(input);
				}
				const shared = kit.shared(`entry:${entryId}`);
				input = shared?.ready() ? propsInput(shared, p.id, state) : null;
				if (input) inlineInputs.add(input);
			});
			el.addEventListener("paste", (event) => {
				event.preventDefault();
				kit.doc.execCommand("insertText", false, event.clipboardData?.getData("text/plain") ?? "");
			});
			el.addEventListener("keydown", (event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					el.textContent = before;
					el.blur();
				}
				if (event.key === "Enter") {
					event.preventDefault();
					el.blur();
				}
			});
			el.addEventListener("blur", () => {
				const text = (el.textContent ?? "").replace(/[\r\n]+/g, " ");
				if (input) {
					inlineInputs.delete(input);
					if (text !== before && input.change(f, text)) void finishInput(p.id, input);
					else input.cancel();
					input = null;
				} else if (text !== before) {
					saved = false;
					announce(kit.errorText("CHANGED_MEANWHILE"), true);
				}
			});
		}
	}
	function click(event: Event) {
		if (!canEdit()) return;
		const el = (event.target as Element)?.closest?.<HTMLElement>("[data-wc-page-placement]");
		if (el) {
			select(el.dataset.wcPagePlacement ?? null);
			if (kit.phone() && !(event.target as Element).closest("[contenteditable]")) panel = "inspector";
			emit();
		}
	}
	function mode() {
		if (!kit.editing()) {
			panel = null;
			selected = null;
		}
		attachInline();
		outline();
		emit();
	}
	kit.doc.addEventListener("click", click);
	kit.doc.addEventListener("webcraft:edit-mode", mode);
	attachInline();
	outline();
	let stop: (() => void) | undefined;
	const connect = () => {
		if (disposed) return;
		const shared = kit.shared(`entry:${entryId}`);
		if (!shared) {
			kit.later(connect, 100);
			return;
		}
		stop = shared.listen(() => {
			// Read after pending own saves: an acknowledgement is not a peer edit. Never discard a
			// peer notification received during an HTTP write or its preview refresh.
			void enqueue(async () => {
				const layout = (shared.draft() as { layout?: unknown })?.layout;
				if (sameValue(layout ?? { placements: [] }, state.layout)) return;
				finishGrab();
				await reload();
				await refreshPage();
			});
		});
	};
	connect();
	const leaving = (event: BeforeUnloadEvent) => {
		const active = kit.doc.activeElement as HTMLElement | null;
		if (active?.matches("[data-wc-placement-prop]")) active.blur();
		for (const flush of flushers) flush();
		if (queued || busy) {
			event.preventDefault();
			event.returnValue = "";
		}
	};
	kit.doc.defaultView?.addEventListener("beforeunload", leaving);
	function finishGrab() {
		if (!grabbed) return;
		const before = grabbed;
		grabbed = null;
		if (!sameValue(before, state.layout))
			for (const listener of finished)
				listener({ before, after: state.layout, label: kit.word("pageLayout.move"), selection: selected, panel });
	}
	async function grab(change: "pick" | "drop" | "cancel") {
		if (change === "pick") {
			if (!busy && canEdit() && selection() && (!selection()?.locked || state.canLock)) {
				grabbed = structuredClone(state.layout);
				emit();
			}
			return;
		}
		return enqueue(async () => {
			if (grabbed && change === "cancel") {
				const positions = new Map(grabbed.placements.map((p, i) => [p.id, i]));
				grabbed = null;
				// Cancel only this movement. Keep the latest Props and flags on every surviving row.
				const next = structuredClone(state.layout);
				next.placements.sort(
					(a, b) =>
						(positions.get(a.id) ?? Number.POSITIVE_INFINITY) - (positions.get(b.id) ?? Number.POSITIVE_INFINITY),
				);
				await save(next, kit.word("pageLayout.move"), state.layout, { record: false, focus: true });
			} else finishGrab();
			emit();
		}, true);
	}
	return {
		state: () => ({
			entryId,
			data: state,
			selected,
			panel,
			focusRequest,
			grabbed: !!grabbed,
			busy,
			editing: canEdit(),
		}),
		values,
		label,
		allowed,
		select,
		action,
		insert,
		prop,
		flushProps,
		grab,
		openLayout(focus = true) {
			if (!canEdit()) return;
			panel = "tree";
			if (!selected) selected = state.layout.placements[0]?.id ?? null;
			if (focus) focusRequest++;
			emit();
		},
		openProps(focus = true) {
			if (!canEdit()) return;
			if (grabbed) void grab("drop");
			panel = "inspector";
			if (focus) focusRequest++;
			emit();
		},
		openPicker() {
			if (!canEdit()) return;
			if (grabbed) void grab("drop");
			panel = "picker";
			focusRequest++;
			emit();
		},
		close() {
			for (const flush of flushers) flush();
			if (grabbed) void grab("drop");
			panel = null;
			emit();
		},
		async drop(from: number, to: number) {
			const p = state.layout.placements[from];
			const target = state.layout.placements[to];
			if (!p || !target || !canEdit() || busy) return;
			select(p.id);
			await enqueue(async () => {
				// Resolve both stable identities after queued peer updates, never reuse a stale row or index.
				const sourceAt = state.layout.placements.findIndex((row) => row.id === p.id);
				const targetAt = state.layout.placements.findIndex((row) => row.id === target.id);
				if (!canEdit() || sourceAt < 0 || targetAt < 0) return;
				if (
					!state.canLock &&
					state.layout.placements
						.slice(Math.min(sourceAt, targetAt), Math.max(sourceAt, targetAt) + 1)
						.some((p) => p.locked)
				)
					return;
				finishGrab();
				const next = structuredClone(state.layout);
				const [moving] = next.placements.splice(sourceAt, 1);
				if (!moving) return;
				next.placements.splice(targetAt + (from < to ? 1 : 0) - (sourceAt < targetAt ? 1 : 0), 0, moving);
				await save(next, kit.word("pageLayout.move"), state.layout, { focus: true });
			}, true);
		},
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		finished(listener: (step: LayoutStep) => void) {
			finished.add(listener);
			return () => {
				finished.delete(listener);
			};
		},
		/**
		 * Hears each own action the moment it is made, before its save is acknowledged; the listener
		 * answers what to call once that action is over, accepted or refused. Its `finished` steps, if
		 * any, come in between. The Undo history keeps own steps in the order they were made with it.
		 */
		began(listener: () => () => void) {
			began.add(listener);
			return () => {
				began.delete(listener);
			};
		},
		flushWith(flush: () => void) {
			flushers.add(flush);
			return () => {
				flushers.delete(flush);
			};
		},
		async finish() {
			for (const flush of flushers) flush();
			const active = kit.doc.activeElement as HTMLElement | null;
			if (active?.matches("[data-wc-placement-prop]")) active.blur();
			await pending;
			if (grabbed) await grab("drop");
			await pending;
			return saved;
		},
		dispose() {
			disposed = true;
			for (const input of inputs.values()) input.cancel();
			inputs.clear();
			for (const input of inlineInputs) input.cancel();
			inlineInputs.clear();
			stop?.();
			kit.doc.defaultView?.removeEventListener("beforeunload", leaving);
			kit.doc.removeEventListener("click", click);
			kit.doc.removeEventListener("webcraft:edit-mode", mode);
		},
	};
}
export type PageLayoutController = ReturnType<typeof pageLayoutController>;
