import { TEXT_REGION } from "../agent/contract.ts";
import { type EditRequests, fill, type Words } from "../api.ts";

/**
 * Content typed in place in the frame (ADR 0037): the caret lives in the page, made editable by the
 * page agent; the shell saves each text region to the Draft through the page's `save` edit request,
 * 0.8 s after typing stops and when the region is left, as the editing bar does.
 */
export type RegionSaving = {
	/**
	 * The page the frame now shows: its regions' values as they are, and (when given) its language
	 * once known, which every save then waits for.
	 */
	track(document: Document, language?: Promise<string | null>): void;
	/** Text was typed in a region: saved once typing stops. */
	typed(region: Element): void;
	/** A region was left: saved now. */
	left(region: Element): Promise<void>;
	/** The region an element is in, if it is in one. */
	regionOf(element: Element): HTMLElement | null;
	/** Saves every region typed in and not saved yet, now (before the building area is left). */
	flush(): Promise<void>;
	/**
	 * Whether a region holds what wasn't saved yet: typed in, its save waiting or under way. A change
	 * that arrives from elsewhere (someone else's, an Undo) leaves such a region as the person has it.
	 */
	unsaved(region: Element): boolean;
	/** The region's value now: plain text on one line, or rich text's HTML. */
	valueOf(region: Element): string;
	/** The region shows what its Draft holds now (put there from elsewhere): nothing to save. */
	remember(region: Element): void;
};

/** What `save` answers for a region: the value as stored, its problems, and the change it made. */
export type SavedAnswer = {
	value: unknown;
	problems: { rule?: string | null }[];
	/** The change to the item's shared Draft, exactly (ADR 0036): the person's step in the Undo history. */
	history?: { resource: string; before: unknown; after: unknown };
};

/**
 * Follows one save of a region (`regionSaving`'s `watch`): asked for as the save is asked for, so the
 * Undo history keeps steps in the order they were made, whichever save is answered first.
 */
export type SaveWatch = {
	/** The save was answered: what it stored. */
	saved(answer: SavedAnswer): void;
	/** The save is over, answered, refused or not needed. */
	settle(): void;
};

/** Where saving stands, for the Draft state beside Publish: a save under way, the last one done or failed. */
export type SavingStatus = "saving" | "saved" | "failed";

/** How long after the last keystroke a region saves, in milliseconds. */
const SAVE_DELAY_MS = 800;

export function regionSaving(options: {
	request: EditRequests;
	words: Words;
	announce(text: string, urgent?: boolean): void;
	/** Called as saves start and end. */
	status?(status: SavingStatus): void;
	/** Follows each save from the moment it is asked for (the Undo history, the region's problems). */
	watch?(region: Element): SaveWatch | undefined;
}): RegionSaving {
	const { request, words, announce, status, watch } = options;
	/** Regions waiting to save (typed in, the delay not over yet). */
	const waiting = new Set<Element>();
	let running = 0;
	let language: Promise<string | null> = Promise.resolve(null);
	const saved = new WeakMap<Element, string>();
	const timers = new WeakMap<Element, number>();
	const saving = new WeakMap<Element, Promise<void>>();

	const textIn = (region: Element) =>
		region.getAttribute("data-wc-type") === "richText"
			? region.innerHTML
			: (region.textContent ?? "").replace(/[\r\n]+/g, " ");

	const save = async (region: Element) => {
		const timer = timers.get(region);
		if (timer !== undefined) clearTimeout(timer);
		timers.delete(region);
		waiting.delete(region);
		const watching = watch?.(region);
		try {
			// One save of a region at a time, in the order they were asked for.
			await saving.get(region);
			const value = textIn(region);
			if (value === saved.get(region)) return;
			await saveNow(region, value, watching);
		} finally {
			watching?.settle();
		}
	};

	const saveNow = async (region: Element, value: string, watching: SaveWatch | undefined) => {
		const run = (async () => {
			running++;
			status?.("saving");
			const code = await language;
			const answer = await request<SavedAnswer>("save", {
				item: region.getAttribute("data-wc-item") ?? "",
				field: region.getAttribute("data-wc-field") ?? "",
				value,
				...(code ? { language: code } : {}),
			});
			running--;
			if (!answer.ok) {
				status?.("failed");
				announce(
					answer.code === "EDIT_MODE_ENDED" ? words.ended : fill(words.saveFailed, { reason: answer.code }),
					true,
				);
				return;
			}
			saved.set(region, value);
			watching?.saved(answer.data);
			if (running === 0) status?.("saved");
			announce(words.saved);
		})();
		saving.set(region, run);
		await run;
	};

	return {
		track(document, pageLanguage) {
			if (pageLanguage) language = pageLanguage;
			for (const region of document.querySelectorAll(TEXT_REGION)) saved.set(region, textIn(region));
		},
		typed(region) {
			if (!saved.has(region)) saved.set(region, "");
			const timer = timers.get(region);
			if (timer !== undefined) clearTimeout(timer);
			waiting.add(region);
			timers.set(
				region,
				window.setTimeout(() => void save(region), SAVE_DELAY_MS),
			);
		},
		left: save,
		regionOf: (element) => element.closest<HTMLElement>(TEXT_REGION),
		async flush() {
			await Promise.all([...waiting].map((region) => save(region)));
		},
		unsaved: (region) => waiting.has(region) || (saved.has(region) && textIn(region) !== saved.get(region)),
		valueOf: textIn,
		remember(region) {
			saved.set(region, textIn(region));
		},
	};
}
