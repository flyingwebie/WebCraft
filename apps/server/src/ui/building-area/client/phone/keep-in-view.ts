import { useEffect } from "react";

import type { PageEditing } from "../../editing/editing.ts";
import type { RegionPopovers } from "../popovers.ts";
import { keepAbove } from "./layout.ts";

/**
 * On a phone, nothing covers what is being edited (SPEC 13.9; the owner's words): when a photo's or a
 * link's popover comes up as a sheet, when text is edited with its toolbar on the keyboard, and when
 * the keyboard comes or goes, the page in the frame scrolls so that the thing being changed ends above
 * the sheet, the toolbar or the keyboard.
 */
export function useKeepInView({
	on,
	editing,
	popovers,
	keyboard,
}: {
	on: boolean;
	editing: PageEditing;
	popovers: RegionPopovers;
	/** The keyboard's inset at the bottom of the window (`useKeyboardInset`). */
	keyboard: number;
}): void {
	useEffect(() => {
		if (!on) return;
		let frame = 0;
		const check = () => {
			cancelAnimationFrame(frame);
			// Once the sheet or the toolbar is drawn where it goes: two frames.
			frame = requestAnimationFrame(() => {
				frame = requestAnimationFrame(() => {
					const open = popovers.snapshot().open;
					if (open) {
						const sheet = document.querySelector("[data-wc-popover]");
						if (sheet) keepAbove(open.element, sheet.getBoundingClientRect().top);
						return;
					}
					const region = editing.snapshot().region;
					if (!region) return;
					const toolbar = document.querySelector("[data-wc-text-toolbar]");
					const top = toolbar ? toolbar.getBoundingClientRect().top : window.innerHeight - keyboard;
					keepAbove(region.element, top);
				});
			});
		};
		const stopEditing = editing.subscribe(check);
		const stopPopovers = popovers.subscribe(check);
		check();
		return () => {
			cancelAnimationFrame(frame);
			stopEditing();
			stopPopovers();
		};
	}, [on, editing, popovers, keyboard]);
}
