import { useEffect, useState, useSyncExternalStore } from "react";

import type { Words } from "../api.ts";
import type { GoToData } from "../management.ts";
import { LinkPopover } from "./LinkPopover.tsx";
import { PhotoPopover } from "./PhotoPopover.tsx";
import type { RegionPopovers } from "./popovers.ts";

/**
 * The popover open on the page now, if any (BA-15): the photo's or the link's, drawn in the shell's
 * document over the frame and following its element as the page scrolls, resizes or narrows.
 */
export function RegionPopover({
	popovers,
	words,
	goTo,
}: {
	popovers: RegionPopovers;
	words: Words;
	goTo(): Promise<GoToData>;
}) {
	const { open, picking, status } = useSyncExternalStore(popovers.subscribe, popovers.snapshot);
	const [, setMoved] = useState(0);
	useEffect(() => popovers.onMove(() => setMoved((count) => count + 1)), [popovers]);
	if (!open?.element.isConnected) return null;
	const box = popovers.boxOf(open.element);
	if (!box) return null;
	const common = {
		popovers,
		words,
		element: open.element,
		name: open.name,
		focus: open.focus,
		seq: open.seq,
		hidden: picking,
		box,
	};
	return open.kind === "photo" ? (
		<PhotoPopover key={open.seq} {...common} status={status} />
	) : (
		<LinkPopover key={open.seq} {...common} goTo={goTo} />
	);
}
