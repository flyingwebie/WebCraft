// Co-editing in Edit mode (ADR 0025): the module the editing bar loads on a Site's own domain. The bar
// is one self-contained function that can't import anything, so this module hands it the shared-Draft
// client in an event once it has loaded (`DRAFTS_LOADED_EVENT`). It runs in the browser only.
import * as drafts from "./browser.ts";

type Page = {
	document: { dispatchEvent(event: unknown): boolean };
	CustomEvent: new (type: string, init: { detail: unknown }) => unknown;
};

const page = globalThis as unknown as Page;
page.document.dispatchEvent(new page.CustomEvent(drafts.DRAFTS_LOADED_EVENT, { detail: drafts }));

// The React panels import this same browser module, so each page loads Yjs only once.
export * from "./browser.ts";
