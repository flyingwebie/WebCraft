import { LINK_REGION, PHOTO_REGION } from "../agent/contract.ts";
import { type EditAnswer, editRequests, fill, type PageState, type Words } from "../api.ts";
import type { Overlay } from "../canvas/overlay.ts";
import type { SavedAnswer, SavingStatus } from "../canvas/regions.ts";
import type { ShellHistory } from "../editing/history.ts";

/**
 * The popovers of client editing (SPEC 13.3, BA-15; `client/03` and `client/04`): one value changed
 * where it is. A photo opens the photo popover (Choose from Media, Upload or a file dropped on the
 * photo, its description in the page's language, its Focal point dragged on the photo); a link or a
 * button the link popover (its words, where it goes, a new tab). Each belongs to its element on the
 * page: it opens beside it, names it (so the element's chip isn't drawn), closes with Escape and gives
 * focus back to it.
 *
 * This is their controller, which the marks (`marks.ts`) and the shell call; React draws them from
 * `snapshot()` (`PhotoPopover.tsx`, `LinkPopover.tsx`). What they change goes through the edit requests
 * Content uses (`image`, `save` with a link, `media/*`): the photo and the link to the Draft, a
 * photo's description and Focal point to the Media item itself, live at once on every page showing it
 * (as in the Media place).
 */
export type RegionPopovers = {
	/** The frame is there: its element and its overlay (where an element of the page is). Answers how to stop. */
	connect(parts: { frame: HTMLIFrameElement; overlay: Overlay }): () => void;
	/** Another page started in the frame: what was open closes. */
	page(document: Document): void;
	/** What Edit mode says of the page now: the language a photo's description is written in. */
	pageState(state: PageState): void;
	/** Whether an element of the page is a photo or a link region, and which. */
	kindOf(element: Element | null): PopoverKind | null;
	/** Opens the popover of a photo or a link region; `focus` names the control that gets focus in it. */
	open(element: HTMLElement, focus?: string): void;
	/** Closes the popover open now; with `returnFocus`, focus goes back to its element on the page. */
	close(returnFocus: boolean): void;
	snapshot(): PopoverSnapshot;
	/** Called when the snapshot changes. Answers how to stop listening. */
	subscribe(listener: () => void): () => void;
	/** Where an element of the page is on the shell's window, and a listener for when it moves. */
	boxOf(element: Element): DOMRect | null;
	onMove(listener: () => void): () => void;
	/** A drag over the page (from the agent): a file dropped on a photo puts it there. True when taken. */
	drag(kind: "dragover" | "dragleave" | "drop", event: Event): boolean;
	/** The language the page is shown in (a photo's description is written in it). */
	language(): { code: string; name: string } | null;
	/** While the Media picker is open, the popover it came from waits hidden. */
	picking(on: boolean): void;
	/**
	 * One of the page's Drafts changed (a step taken back, someone else's change): the photos and links
	 * whose value changed show it, read again from the page as the server renders it once `saved` (what
	 * was sent is saved) resolves (BA-35).
	 */
	draftChanged(item: string, draft: unknown, saved: () => Promise<unknown>): void;
	photo: PhotoActions;
	link: LinkActions;
	destroy(): void;
};

export type PopoverKind = "photo" | "link";

export type PopoverSnapshot = {
	/** The popover open now: what kind, on which element of the page, named by its Field's label. */
	open: { kind: PopoverKind; element: HTMLElement; name: string; focus: string | null; seq: number } | null;
	/** The photo a file is dragged over now (outlined to drop on). */
	drop: HTMLElement | null;
	/** The Media picker is open from the photo popover: the popover waits hidden. */
	picking: boolean;
	/** What a photo's upload says now ("Uploading …"), or null. */
	status: string | null;
};

/** A photo of the Site's Media library as the photo popover shows it (`media/get`). */
export type PhotoMedia = {
	id: string;
	fileName: string;
	alt: string | null;
	width: number | null;
	height: number | null;
	sizeBytes: number;
	status: "processing" | "ready" | "failed";
	url: string | null;
	thumbnail: string | null;
	focalPoint: { x: number; y: number } | null;
	canEdit: boolean;
};

/** What the photo popover does to its photo region. */
export type PhotoActions = {
	/** The photo a region shows now, its description in the page's language, and whether AI can suggest one. */
	load(mediaId: string): Promise<{ media: PhotoMedia; suggestions: boolean } | null>;
	/** Puts another photo of the library in the region (null: none), in the Draft: the region shown again. */
	choose(element: HTMLElement, mediaId: string | null): Promise<HTMLElement | null>;
	/** Uploads a file to the library and, once it is ready, puts it in the region. */
	upload(element: HTMLElement, file: File): Promise<void>;
	/** Saves the photo's description in the page's language (the Media item's own). */
	describe(mediaId: string, alt: string): Promise<boolean>;
	/** An AI's description of the photo, in the page's language; nothing is saved. */
	suggest(mediaId: string): Promise<string | null>;
	/** Saves the photo's Focal point (the Media item's own), and the page's images of it follow. */
	focus(mediaId: string, point: { x: number; y: number }): Promise<boolean>;
};

/** A link as the link popover changes it. */
export type LinkValue = { url: string; text: string; newTab: boolean };

/** What the link popover does to its link region. */
export type LinkActions = {
	/** The link a region shows now, read from the page. */
	read(element: HTMLElement): LinkValue | null;
	/** Saves the link (null removes it) to the Draft, and the page shows it at once. Answers the refusal's reason, if any. */
	save(element: HTMLElement, value: LinkValue | null): Promise<{ ok: true } | { ok: false; reason: string }>;
};

/** How often an upload is asked about while the worker gets it ready, and how many times. */
const POLL_MS = 1000;
const POLL_TIMES = 120;

/** The header edit requests carry the session's header token in. */
const EDIT_TOKEN_HEADER = "x-webcraft-edit-token";

/** The Focal point's classes on a page's images, as the renderer writes them (steps of 5). */
function focalClasses(point: { x: number; y: number }): string[] {
	const step = (value: number) => Math.min(100, Math.max(0, Math.round(value / 5) * 5));
	return ["wc-focus", `wc-fx-${step(point.x)}`, `wc-fy-${step(point.y)}`];
}

export function regionPopovers(options: {
	token: string;
	words: Words;
	announce(text: string, urgent?: boolean): void;
	/** Reads the page's `state` again: the Draft changed. */
	refresh(): void;
	/** The Draft's state beside Publish: saving, saved, could not save. */
	saving(status: SavingStatus): void;
	/** The tab's Undo history: a photo chosen or a link saved is a step, as typed text is (BA-35). */
	history?: Pick<ShellHistory, "watch">;
}): RegionPopovers {
	const { words, announce } = options;
	const request = editRequests(options.token);
	const said = words.client;
	const listeners = new Set<() => void>();
	const moves = new Set<() => void>();
	let snapshot: PopoverSnapshot = { open: null, drop: null, picking: false, status: null };
	let seq = 0;
	const set = (next: Partial<PopoverSnapshot>) => {
		snapshot = { ...snapshot, ...next };
		for (const listener of listeners) listener();
	};

	let parts: { frame: HTMLIFrameElement; overlay: Overlay } | null = null;
	let doc: Document | null = null;
	let language: { code: string; name: string } | null = null;
	/** The page's title, for a step's "on {page}". */
	let title = "";
	/** The photos and links whose save is on its way (`item|field`): a change of their Draft meanwhile is theirs. */
	const busy = new Set<string>();
	/** Each Draft's values as last seen, by item, then key (as JSON): what changed in it. */
	const seen = new Map<string, Map<string, string>>();
	const keyOf = (element: Element) =>
		`${element.getAttribute("data-wc-item") ?? ""}|${element.getAttribute("data-wc-field") ?? ""}`;

	/**
	 * The step a photo's or a link's save makes in the Undo history, kept in its place from the moment it
	 * is asked for. `done` is always called: Undo waits for every step on its way.
	 */
	const step = (element: HTMLElement) => {
		const watch = options.history?.watch({
			label: nameOf(element),
			field: element.dataset.wcField ?? "",
			title,
		});
		return {
			done(answer: SavedAnswer | null) {
				if (answer) watch?.saved(answer);
				watch?.settle();
			},
		};
	};

	const view = () => parts?.frame.contentWindow as (Window & typeof globalThis) | null | undefined;
	const regionOf = (target: EventTarget | null, selector: string): HTMLElement | null => {
		const win = view();
		return win && target instanceof win.Element ? target.closest<HTMLElement>(selector) : null;
	};
	const kindOf = (element: Element | null): PopoverKind | null =>
		!element ? null : element.matches(PHOTO_REGION) ? "photo" : element.matches(LINK_REGION) ? "link" : null;
	const nameOf = (element: Element) =>
		element.getAttribute("data-wc-label") ?? (kindOf(element) === "link" ? said.link.empty : said.photo.empty);
	const reasonOf = (answer: EditAnswer<unknown>) => (answer.ok ? "" : answer.code);

	/** Focus back on an element of the page: the frame first, then the element. */
	const focusOn = (element: HTMLElement) => {
		const frame = parts?.frame;
		if (!frame || !element.isConnected) return;
		frame.focus();
		frame.contentWindow?.focus();
		element.focus({ preventScroll: true });
	};

	const close = (returnFocus: boolean) => {
		const was = snapshot.open;
		if (!was) return;
		set({ open: null, picking: false, status: null });
		parts?.overlay.schedule();
		if (returnFocus) focusOn(was.element);
	};

	const open = (element: HTMLElement, focus?: string) => {
		const kind = kindOf(element);
		if (!kind) return;
		set({ open: { kind, element, name: nameOf(element), focus: focus ?? null, seq: ++seq }, picking: false });
		parts?.overlay.schedule();
	};

	// ── the photo ──

	/** The region in `root` that is the same as `region`: the same item, Field and element. */
	const sameRegion = (root: ParentNode, region: HTMLElement) => {
		const { wcItem, wcField, wcId } = region.dataset;
		return [...root.querySelectorAll<HTMLElement>(PHOTO_REGION)].find(
			(candidate) =>
				candidate.dataset.wcItem === wcItem && candidate.dataset.wcField === wcField && candidate.dataset.wcId === wcId,
		);
	};
	/** The element a region stands for on the page: its `<picture>` when it has one. */
	const outer = (region: Element): Element =>
		region.parentElement?.tagName === "PICTURE" ? region.parentElement : region;

	/**
	 * Shows the region as the page has it now, read again from the server (the new photo, its sizes,
	 * its Focal point's classes): answers the region that took its place.
	 */
	const refreshRegion = async (region: HTMLElement): Promise<HTMLElement> => {
		const win = region.ownerDocument.defaultView;
		if (!win) return region;
		try {
			const response = await fetch(win.location.href, { credentials: "same-origin", cache: "no-store" });
			if (!response.ok) return region;
			const fresh = new DOMParser().parseFromString(await response.text(), "text/html");
			const found = sameRegion(fresh, region);
			if (!found || !region.isConnected) return region;
			const replacement = region.ownerDocument.importNode(outer(found), true) as Element;
			outer(region).replaceWith(replacement);
			const next = replacement.matches(PHOTO_REGION)
				? (replacement as HTMLElement)
				: replacement.querySelector<HTMLElement>(PHOTO_REGION);
			parts?.overlay.schedule();
			return next ?? region;
		} catch {
			return region;
		}
	};

	const load: PhotoActions["load"] = async (mediaId) => {
		const answer = await request<{ media: PhotoMedia; altTextSuggestions: boolean }>("media/get", {
			media: mediaId,
			...(language ? { language: language.code } : {}),
		});
		return answer.ok ? { media: answer.data.media, suggestions: answer.data.altTextSuggestions } : null;
	};

	const choose: PhotoActions["choose"] = async (element, mediaId) => {
		options.saving("saving");
		const made = step(element);
		const key = keyOf(element);
		busy.add(key);
		const answer = await request<{
			media: string | null;
			problems: SavedAnswer["problems"];
			history?: SavedAnswer["history"];
		}>("image", {
			item: element.dataset.wcItem,
			field: element.dataset.wcField,
			media: mediaId,
			...(language ? { language: language.code } : {}),
		}).catch(() => null);
		if (!answer?.ok) {
			busy.delete(key);
			made.done(null);
			options.saving("failed");
			announce(fill(said.photo.failed, { reason: answer ? reasonOf(answer) : "network" }), true);
			return null;
		}
		made.done({ value: answer.data.media, problems: answer.data.problems ?? [], history: answer.data.history });
		const next = await refreshRegion(element);
		busy.delete(key);
		options.saving("saved");
		announce(mediaId ? said.photo.changed : said.photo.removed);
		options.refresh();
		// The popover follows its photo to the element that took its place.
		if (snapshot.open?.element === element) {
			set({ open: { ...snapshot.open, element: next, focus: snapshot.open.focus, seq: ++seq } });
		}
		return next;
	};

	/** Says how an upload goes: in the popover's status line while it is open, and to screen readers. */
	const tell = (text: string | null, urgent = false) => {
		set({ status: text });
		if (text) announce(text, urgent);
	};

	/** Waits until the worker has made an upload ready (or refused it): the item as it is then. */
	const ready = async (media: PhotoMedia): Promise<PhotoMedia | null> => {
		let current = media;
		for (let tries = 0; current.status === "processing" && tries < POLL_TIMES; tries++) {
			if (tries === 0) tell(fill(said.photo.preparing, { name: current.fileName }));
			await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
			const loaded = await load(current.id);
			if (loaded) current = loaded.media;
		}
		return current.status === "ready" ? current : null;
	};

	const upload: PhotoActions["upload"] = async (element, file) => {
		if (!file.type.startsWith("image/") && file.type !== "") {
			tell(fill(said.photo.notAnImage, { name: file.name }), true);
			return;
		}
		tell(fill(said.photo.uploading, { name: file.name }));
		options.saving("saving");
		const form = new FormData();
		form.append("file", file);
		let uploaded: PhotoMedia | null = null;
		let reason = "network";
		try {
			const response = await fetch("/_webcraft/edit/api/media/upload", {
				method: "POST",
				credentials: "same-origin",
				headers: { [EDIT_TOKEN_HEADER]: options.token },
				body: form,
			});
			const data = (await response.json().catch(() => null)) as { media?: PhotoMedia; code?: string } | null;
			if (response.ok && data?.media) uploaded = data.media;
			else reason = data?.code ?? String(response.status);
		} catch {
			reason = "network";
		}
		const made = uploaded && (await ready(uploaded));
		if (!made) {
			options.saving("failed");
			tell(fill(said.photo.uploadFailed, { name: file.name, reason: uploaded ? "failed" : reason }), true);
			return;
		}
		tell(null);
		await choose(element, made.id);
	};

	const describe: PhotoActions["describe"] = async (mediaId, alt) => {
		const answer = await request<{ media: PhotoMedia }>("media/update", {
			media: mediaId,
			alt,
			...(language ? { language: language.code } : {}),
		});
		if (!answer.ok) {
			announce(fill(said.photo.failed, { reason: reasonOf(answer) }), true);
			return false;
		}
		// The page's images of it that showed its description show the new one.
		for (const image of doc?.querySelectorAll<HTMLImageElement>("img[data-wc-media]") ?? []) {
			if (image.dataset.wcMedia !== mediaId || image.dataset.wcImageDecorative === "true") continue;
			image.alt = alt;
		}
		announce(said.photo.altSaved);
		return true;
	};

	const suggest: PhotoActions["suggest"] = async (mediaId) => {
		announce(said.photo.suggesting);
		const answer = await request<{ alt: string }>("media/suggestAlt", {
			media: mediaId,
			...(language ? { language: language.code } : {}),
		});
		if (!answer.ok) {
			announce(fill(said.photo.failed, { reason: reasonOf(answer) }), true);
			return null;
		}
		announce(said.photo.suggested);
		return answer.data.alt;
	};

	const focus: PhotoActions["focus"] = async (mediaId, point) => {
		const answer = await request("media/update", { media: mediaId, focalPoint: point });
		if (!answer.ok) {
			announce(fill(said.photo.failed, { reason: reasonOf(answer) }), true);
			return false;
		}
		for (const image of doc?.querySelectorAll<HTMLImageElement>("img[data-wc-media]") ?? []) {
			if (image.dataset.wcMedia !== mediaId) continue;
			for (const name of [...image.classList]) {
				if (name === "wc-focus" || /^wc-f[xy]-\d+$/.test(name)) image.classList.remove(name);
			}
			image.classList.add(...focalClasses(point));
		}
		announce(fill(said.photo.focalSaved, { at: fill(said.photo.focalAt, { x: String(point.x), y: String(point.y) }) }));
		return true;
	};

	/**
	 * Photos and links whose value changed in their Draft without a save of the person's (a step taken
	 * back, someone else's change), shown as the server renders the page now: a photo takes the element
	 * the page has (its sizes, its Focal point), a link its address, words and tab.
	 */
	const showFromServer = async (regions: HTMLElement[], saved: () => Promise<unknown>) => {
		await saved().catch(() => {});
		const win = regions[0]?.ownerDocument.defaultView;
		if (!win) return;
		let fresh: Document;
		try {
			const response = await fetch(win.location.href, { credentials: "same-origin", cache: "no-store" });
			if (!response.ok) return;
			fresh = new DOMParser().parseFromString(await response.text(), "text/html");
		} catch {
			return;
		}
		for (const region of regions) {
			if (!region.isConnected || busy.has(keyOf(region))) continue;
			if (region.matches(LINK_REGION)) {
				const found = [...fresh.querySelectorAll<HTMLElement>(LINK_REGION)].find(
					(each) => keyOf(each) === keyOf(region) && each.dataset.wcId === region.dataset.wcId,
				);
				if (!found) continue;
				const text = (found.textContent ?? "").trim();
				const url = found.getAttribute("href") ?? "";
				showLink(region, url || text ? { url, text, newTab: found.getAttribute("target") === "_blank" } : null);
				continue;
			}
			const found = sameRegion(fresh, region);
			// Already shown (the person's own save got there first): left as it is, with what Edit gave it.
			const same = (name: string) => found?.getAttribute(name) === region.getAttribute(name);
			if (!found || (same("data-wc-media") && same("src") && same("class"))) continue;
			const replacement = region.ownerDocument.importNode(outer(found), true) as Element;
			outer(region).replaceWith(replacement);
			const next = replacement.matches(PHOTO_REGION)
				? (replacement as HTMLElement)
				: replacement.querySelector<HTMLElement>(PHOTO_REGION);
			// An open popover follows its photo to the element that took its place.
			if (next && snapshot.open?.element === region) {
				set({ open: { ...snapshot.open, element: next, focus: snapshot.open.focus, seq: ++seq } });
			}
		}
		parts?.overlay.schedule();
	};

	// ── the link ──

	const read: LinkActions["read"] = (element) => {
		const url = element.getAttribute("href") ?? "";
		const text = (element.textContent ?? "").trim();
		if (!url && !text) return null;
		return { url, text: text === url ? "" : text, newTab: element.getAttribute("target") === "_blank" };
	};

	/** Shows a link as stored: its address, its words (its address when it has none), a new tab. */
	const showLink = (element: HTMLElement, stored: { url: string; text: string; newTab?: boolean } | null) => {
		if (stored) {
			element.setAttribute("href", stored.url);
			element.textContent = stored.text || stored.url;
		} else {
			// As the page renders a link Field with no value: an empty address, so it can still be reached.
			element.setAttribute("href", "");
			element.textContent = "";
		}
		if (stored?.newTab) {
			element.setAttribute("target", "_blank");
			element.setAttribute("rel", "noopener");
		} else if (element.getAttribute("target") === "_blank") {
			element.removeAttribute("target");
			element.removeAttribute("rel");
		}
	};

	const save: LinkActions["save"] = async (element, value) => {
		options.saving("saving");
		const made = step(element);
		const key = keyOf(element);
		busy.add(key);
		const answer = await request<{
			value: { url: string; text: string; newTab?: boolean } | null;
			problems: SavedAnswer["problems"];
			history?: SavedAnswer["history"];
		}>("save", {
			item: element.dataset.wcItem,
			field: element.dataset.wcField,
			value: value && { url: value.url, text: value.text, newTab: value.newTab },
			...(language ? { language: language.code } : {}),
		}).catch(() => null);
		busy.delete(key);
		if (!answer?.ok) {
			made.done(null);
			options.saving("failed");
			return { ok: false, reason: answer ? answer.code : "network" };
		}
		made.done({ value: answer.data.value, problems: answer.data.problems ?? [], history: answer.data.history });
		// The page shows the link as stored, at once.
		const stored = answer.data.value;
		showLink(element, stored);
		parts?.overlay.schedule();
		options.saving("saved");
		announce(stored ? said.link.saved : said.link.removed);
		options.refresh();
		return { ok: true };
	};

	return {
		connect(next) {
			parts = next;
			const stop = next.overlay.onDraw(() => {
				for (const listener of moves) listener();
			});
			return () => {
				stop();
				close(false);
				parts = null;
			};
		},
		page(document) {
			doc = document;
			close(false);
			set({ drop: null });
		},
		pageState(state) {
			language = state.language;
			title = state.page.title || state.page.path || "";
		},
		draftChanged(item, draft, saved) {
			const values = (draft as { values?: Record<string, unknown> } | null)?.values ?? {};
			const before = seen.get(item);
			const now = new Map(Object.entries(values).map(([key, value]) => [key, JSON.stringify(value ?? null)]));
			seen.set(item, now);
			if (!before || !doc) return;
			const changed = [...doc.querySelectorAll<HTMLElement>(`${PHOTO_REGION}, ${LINK_REGION}`)].filter((region) => {
				if (region.dataset.wcItem !== item || region.dataset.wcBlock !== undefined || busy.has(keyOf(region)))
					return false;
				const key = (region.dataset.wcField ?? "").split(".")[0] ?? "";
				return (before.get(key) ?? "null") !== (now.get(key) ?? "null");
			});
			if (changed.length > 0) void showFromServer(changed, saved);
		},
		kindOf,
		open,
		close,
		snapshot: () => snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		boxOf: (element) => parts?.overlay.boxOf(element) ?? null,
		onMove(listener) {
			moves.add(listener);
			return () => {
				moves.delete(listener);
			};
		},
		drag(kind, event) {
			const drag = event as DragEvent;
			if (![...(drag.dataTransfer?.types ?? [])].includes("Files")) return false;
			const photo = regionOf(event.target, PHOTO_REGION);
			switch (kind) {
				case "dragover":
					// Only a photo takes a file; anywhere else the page isn't left for the file.
					if (drag.dataTransfer) drag.dataTransfer.dropEffect = photo ? "copy" : "none";
					if (photo !== snapshot.drop) {
						set({ drop: photo });
						parts?.overlay.schedule();
					}
					return true;
				case "dragleave": {
					const into = (drag.relatedTarget as Element | null) ?? null;
					if (snapshot.drop && !(into && snapshot.drop.contains(into))) {
						set({ drop: null });
						parts?.overlay.schedule();
					}
					return false;
				}
				default: {
					set({ drop: null });
					parts?.overlay.schedule();
					const file = drag.dataTransfer?.files[0];
					if (photo && file) void upload(photo, file);
					return true;
				}
			}
		},
		language: () => language,
		picking(on) {
			set({ picking: on });
		},
		photo: { load, choose, upload, describe, suggest, focus },
		link: { read, save },
		destroy() {
			listeners.clear();
			moves.clear();
		},
	};
}
