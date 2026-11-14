import type { MediaKind } from "@webcraft/core/media-kinds";

import type { MediaItem } from "../../../media/preview.ts";

/**
 * The Media picker's way in (SPEC 8: "the picker is this place in a dialog"; `places-assets/04`): any
 * part of the shell (the Inspector's Media image, the photo popover of BA-15, a media Field) asks for a
 * file with `pickMedia()`, and gets the chosen file back, or null when the person cancels. The shell's
 * Media host (`MediaShellHost`, always mounted) answers it by opening the dialog.
 */

/** The event `pickMedia` sends on the shell's document; its detail is a `PickMediaDetail`. */
export const PICK_MEDIA_EVENT = "webcraft:pick-media";

/** What a caller asks the picker for. */
export type PickMediaRequest = {
	/** Only files of this kind can be chosen ("image" for a Media image); any kind when left out. */
	kind?: MediaKind | null;
	/** The file chosen now, marked in the list. */
	current?: string | null;
};

/** The event's detail: the request, and how the host answers it. */
export type PickMediaDetail = PickMediaRequest & {
	answer(item: MediaItem | null): void;
	/** Set by the host that takes the request; a request nobody takes is answered null at once. */
	taken: boolean;
};

/** Opens the Media picker and answers the file chosen in it, or null. */
export function pickMedia(request: PickMediaRequest = {}): Promise<MediaItem | null> {
	return new Promise((resolve) => {
		const detail: PickMediaDetail = { ...request, answer: resolve, taken: false };
		document.dispatchEvent(new CustomEvent(PICK_MEDIA_EVENT, { detail }));
		if (!detail.taken) resolve(null);
	});
}
