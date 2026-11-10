// The block editor in Edit mode (#79): the module the editing bar loads on a Site's own domain when a
// page shows a body. The bar is one self-contained function that can't import anything, so this
// module hands it the body part in an event once it has loaded (`BODY_LOADED_EVENT`). It runs in the
// browser only.
import { bodyTools } from "./edit-tools.ts";

/** The event this module hands the body part to the editing bar in. */
export const BODY_LOADED_EVENT = "webcraft:body";

document.dispatchEvent(new CustomEvent(BODY_LOADED_EVENT, { detail: { bodyTools } }));
