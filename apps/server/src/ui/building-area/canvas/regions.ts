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
};

/** How long after the last keystroke a region saves, in milliseconds. */
const SAVE_DELAY_MS = 800;

export function regionSaving(options: {
	request: EditRequests;
	words: Words;
	announce(text: string, urgent?: boolean): void;
}): RegionSaving {
	const { request, words, announce } = options;
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
		// One save of a region at a time, in the order they were asked for.
		await saving.get(region);
		const value = textIn(region);
		if (value === saved.get(region)) return;
		const run = (async () => {
			const code = await language;
			const answer = await request<{ value: unknown }>("save", {
				item: region.getAttribute("data-wc-item") ?? "",
				field: region.getAttribute("data-wc-field") ?? "",
				value,
				...(code ? { language: code } : {}),
			});
			if (!answer.ok) {
				announce(
					answer.code === "EDIT_MODE_ENDED" ? words.ended : fill(words.saveFailed, { reason: answer.code }),
					true,
				);
				return;
			}
			saved.set(region, value);
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
			timers.set(
				region,
				window.setTimeout(() => void save(region), SAVE_DELAY_MS),
			);
		},
		left: save,
		regionOf: (element) => element.closest<HTMLElement>(TEXT_REGION),
	};
}
