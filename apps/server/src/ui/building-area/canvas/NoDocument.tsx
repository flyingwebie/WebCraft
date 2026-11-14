import { HouseIcon } from "lucide-react";

import type { Words } from "../api.ts";
import { FOCUS_RING } from "../controls.tsx";

/**
 * The canvas when the address opens no document: nothing of this Site's by that address (another
 * Site's id, a path off the Site, a Template for someone who may not change Structure), or a Form,
 * whose place comes later. It says so, and offers the home page.
 */
export function NoDocument({ words, why }: { words: Words; why: "missing" | "later" }) {
	const shown = words.documents;
	return (
		<div className="absolute inset-0 grid place-items-center p-6" data-wc-no-document={why}>
			<div className="grid max-w-md justify-items-center gap-3 text-center">
				<h1 className="text-chrome-strong m-0 text-[18px] font-semibold">
					{why === "missing" ? shown.missingTitle : shown.formLaterTitle}
				</h1>
				<p className="text-chrome-muted m-0 text-[13px]">
					{why === "missing" ? shown.missingText : shown.formLaterText}
				</p>
				<a
					href="/_webcraft/build/page/"
					className={`border-chrome-hover text-chrome-text hover:bg-chrome-hover flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium ${FOCUS_RING}`}
				>
					<HouseIcon aria-hidden="true" className="size-3.5" />
					{shown.missingLink}
				</a>
			</div>
		</div>
	);
}
