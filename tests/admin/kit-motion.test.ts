// SPEC 10: places, panels, dialogs and menus appear at once, with no slide and no fade; tooltips show
// at once. The shared kit's menus, tooltips, popovers and dialogs carry no enter or exit animation.
// The browser checks read the animation's name on the menus and dialogs the admin and the building area
// open; the kit's tooltip has no screen of its own yet, so its classes are read here. Sheets keep their
// slide from the edge, so they are not in the list.
import { describe, expect, test } from "bun:test";

const KIT = new URL("../../packages/ui/src/components/", import.meta.url);
const APPEARING = ["dropdown-menu.tsx", "tooltip.tsx", "popover.tsx", "dialog.tsx"];
const MOTION = /\b(animate-in|animate-out|fade-(in|out)-\d+|zoom-(in|out)-\d+|slide-(in|out)-from-[a-z]+(-\d+)?)\b/g;

describe("the shared kit's motion", () => {
	for (const file of APPEARING) {
		test(`${file} appears and leaves at once`, async () => {
			const source = await Bun.file(new URL(file, KIT)).text();
			expect({ file, motion: [...source.matchAll(MOTION)].map((match) => match[0]) }).toEqual({ file, motion: [] });
		});
	}
});
