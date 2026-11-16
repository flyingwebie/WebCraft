/**
 * How a body's block editor comes into the frame (BA-18). The page's Blocks are typed where they
 * render, so the editor must run in the page's own realm: it checks what an event happened on with
 * the page's `Element`, and reads and moves the caret in the page. It is the editing bar's body part
 * as it is (`body-editor/edit-mode.ts`, served as `body-*.js`): loaded into the framed page as a
 * module, it hands its `bodyTools` over in an event on the page's document. The shell then gives it
 * a kit (`client/body-in-place.ts`): the page's window and document, the edit requests, the page's
 * shared Draft, and a layer of the shell's own to draw its tools in.
 *
 * Only a page showing a body loads it, and only once per page: nothing of it is in the shell's own
 * files.
 */
import type { BarKit, BodyTools } from "../../page-kit.ts";

/** What the block editor's module hands over (`body-editor/edit-mode.ts`'s `BODY_LOADED_EVENT` detail). */
export type BodyToolsFactory = (kit: BarKit) => BodyTools;

/**
 * The event the module hands its part over in. The same name as `BODY_LOADED_EVENT`, kept here as
 * words: importing that module would run it (and bring the editor into the shell's files).
 */
const BODY_LOADED_EVENT = "webcraft:body";

/** How long the module may take to arrive before the page goes on without it. */
const LOAD_TIMEOUT_MS = 20_000;

const loading = new WeakMap<Document, Promise<BodyToolsFactory | null>>();

/**
 * Loads the block editor into a page of the frame (once per page), answering its `bodyTools`, or null
 * when it couldn't be loaded (the page then shows its body as it is, not editable).
 */
export function loadBodyEditor(page: Document, src: string): Promise<BodyToolsFactory | null> {
	const known = loading.get(page);
	if (known) return known;
	const loaded = new Promise<BodyToolsFactory | null>((resolve) => {
		const view = page.defaultView;
		if (!view) {
			resolve(null);
			return;
		}
		const timer = window.setTimeout(() => resolve(null), LOAD_TIMEOUT_MS);
		page.addEventListener(
			BODY_LOADED_EVENT,
			(event) => {
				window.clearTimeout(timer);
				const detail = (event as CustomEvent<{ bodyTools?: unknown } | null>).detail;
				resolve(typeof detail?.bodyTools === "function" ? (detail.bodyTools as BodyToolsFactory) : null);
			},
			{ once: true },
		);
		const script = page.createElement("script");
		script.type = "module";
		script.src = src;
		script.addEventListener("error", () => {
			window.clearTimeout(timer);
			resolve(null);
		});
		page.head.append(script);
	});
	loading.set(page, loaded);
	return loaded;
}
