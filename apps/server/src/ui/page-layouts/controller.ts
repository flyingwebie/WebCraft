import type { ApiClient } from "@webcraft/api";
import type { FieldDefinition, Json } from "@webcraft/core";
import { type Json as DocumentJson, sameValue } from "@webcraft/core/draft-document";
import type { BarKit } from "../../site/edit-bar/kit.ts";
import { editorAccessibility } from "../builder/editor-accessibility.ts";
import { readFieldValues, writeField } from "../co-editing/values.ts";

export type LayoutState = Awaited<ReturnType<ApiClient["pageLayouts"]["get"]>>;
export type LayoutAction = "moveUp" | "moveDown" | "duplicate" | "delete" | "hide" | "lock";
export type LayoutPanel = "tree" | "inspector" | "picker" | null;
export type LayoutStep = {
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
		const p = state.layout.placements.find((p) => p.id === id);
		return p ? readFieldValues(p.values as Record<string, DocumentJson>, p.props, state) : {};
	};
	const label = (id: string) => {
		const p = state.layout.placements.find((p) => p.id === id);
		if (!p) return "";
		const name =
			state.placements.find((p) => p.id === id)?.componentName ??
			state.components.find((c) => c.id === p.component)?.name ??
			"Component";
		const field = p.props.find((f) => f.type === "text");
		const text = field ? values(id)[field.key] : null;
		return name + (typeof text === "string" && text.trim() ? ` · ${text.trim().slice(0, 100)}` : "");
	};
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
			if (selected && !selection()) selected = null;
			emit();
			outline();
		}
	}
	function enqueue(work: () => Promise<unknown>) {
		queued++;
		const next = pending.then(work).finally(() => {
			queued--;
		});
		pending = next.catch(() => {
			saved = false;
			announce(kit.errorText("generic"), true);
		});
		return pending;
	}
	async function save(next: LayoutState["layout"], title: string, before = state.layout, record = true, focus = false) {
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
		if (focus) focusRequest++;
		if (record)
			for (const listener of finished)
				listener({ before, after: state.layout, label: title, selection: selected, panel });
		emit();
		outline();
		announce(title);
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
		if (id !== selected) for (const flush of flushers) flush();
		selected = id;
		if (options.reveal) panel = "tree";
		if (options.focus) focusRequest++;
		outline();
		if (id) kit.doc.querySelector(`[data-wc-page-placement="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
		emit();
	}
	async function action(action: LayoutAction) {
		if (!allowed(action)) return;
		const id = selected;
		return enqueue(async () => {
			if (!allowed(action, id, true)) return;
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
				await save(next, kit.word("pageLayout.move"), state.layout, false, true);
				announce(`${title}, ${next.placements.findIndex((p) => p.id === selected) + 1} / ${next.placements.length}`);
			} else
				await save(
					next,
					`${kit.word(`pageLayout.${action}`)} ${title}`,
					state.layout,
					true,
					action === "moveUp" || action === "moveDown" || action === "duplicate" || action === "delete",
				);
		});
	}
	async function insert(componentId: string) {
		if (!canEdit() || busy) return;
		return enqueue(async () => {
			const component = state.components.find((c) => c.id === componentId);
			if (!component) return;
			const p = { id: crypto.randomUUID(), component: componentId, props: component.props, values: {} };
			const next = structuredClone(state.layout);
			next.placements.splice(
				selected ? next.placements.findIndex((p) => p.id === selected) + 1 : next.placements.length,
				0,
				p,
			);
			selected = p.id;
			panel = "tree";
			focusRequest++;
			await save(next, `${kit.word("pageLayout.add")} ${component.name}`, state.layout, true, true);
		});
	}
	async function prop(id: string, field: FieldDefinition, value: Json) {
		if (!canEdit()) return;
		return enqueue(async () => {
			const next = structuredClone(state.layout);
			const p = next.placements.find((p) => p.id === id);
			if (!p?.props.some((f) => f.id === field.id && f.key === field.key && f.type === field.type)) return;
			p.values = writeField(p.values as Record<string, DocumentJson>, field, value, state);
			await save(next, `${kit.word("pageLayout.props")} ${label(id)}`);
		});
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
			el.addEventListener("focus", () => {
				before = el.textContent ?? "";
				select(p.id);
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
				if (text !== before) void prop(p.id, f, text);
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
				if (grabbed) {
					const before = grabbed;
					grabbed = null;
					if (!sameValue(before, state.layout))
						for (const listener of finished)
							listener({ before, after: state.layout, label: kit.word("pageLayout.move"), selection: selected, panel });
				}
				await reload();
				await refreshPage();
			});
		});
	};
	connect();
	const leaving = (event: BeforeUnloadEvent) => {
		for (const flush of flushers) flush();
		if (queued || busy) {
			event.preventDefault();
			event.returnValue = "";
		}
	};
	kit.doc.defaultView?.addEventListener("beforeunload", leaving);
	async function grab(change: "pick" | "drop" | "cancel") {
		if (change === "pick") {
			if (!busy && canEdit() && selection() && (!selection()?.locked || state.canLock)) {
				grabbed = structuredClone(state.layout);
				emit();
			}
			return;
		}
		return enqueue(async () => {
			if (grabbed) {
				const before = grabbed;
				grabbed = null;
				if (change === "cancel") {
					await save(before, kit.word("pageLayout.move"), state.layout, false, true);
				} else if (!sameValue(before, state.layout))
					for (const listener of finished)
						listener({ before, after: state.layout, label: kit.word("pageLayout.move"), selection: selected, panel });
			}
			emit();
		});
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
			panel = "inspector";
			if (focus) focusRequest++;
			emit();
		},
		openPicker() {
			if (!canEdit()) return;
			panel = "picker";
			focusRequest++;
			emit();
		},
		close() {
			for (const flush of flushers) flush();
			panel = null;
			emit();
		},
		async drop(from: number, to: number) {
			const p = state.layout.placements[from];
			if (!p || to < 0 || to >= state.layout.placements.length) return;
			select(p.id);
			if (!canEdit() || (!state.canLock && p.locked)) return;
			if (
				!state.canLock &&
				state.layout.placements.slice(Math.min(from, to), Math.max(from, to) + 1).some((p) => p.locked)
			)
				return;
			await enqueue(async () => {
				const next = structuredClone(state.layout);
				next.placements.splice(from, 1);
				next.placements.splice(to, 0, p);
				await save(next, kit.word("pageLayout.move"), state.layout, true, true);
			});
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
			stop?.();
			kit.doc.defaultView?.removeEventListener("beforeunload", leaving);
			kit.doc.removeEventListener("click", click);
			kit.doc.removeEventListener("webcraft:edit-mode", mode);
		},
	};
}
export type PageLayoutController = ReturnType<typeof pageLayoutController>;
