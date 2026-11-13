/**
 * F6 and Shift+F6 move focus between the building area's regions (ADR 0037): the rail, the frame
 * (the page itself), the bottom bar, and back round. Docks join the cycle with their panels. A key
 * pressed in the page reaches here through the page agent, before any Site script sees it.
 */
export type BuildingRegion = "rail" | "canvas" | "bar";

const ORDER: readonly BuildingRegion[] = ["rail", "canvas", "bar"];

export type RegionCycle = {
	/** Handles F6 / Shift+F6 from the shell or, with `from: "canvas"`, from the page. True when taken. */
	key(event: KeyboardEvent, from?: BuildingRegion): boolean;
	focus(region: BuildingRegion): void;
};

export function regionCycle(options: {
	document: Document;
	/** Puts focus in the page shown in the frame. */
	focusFrame(): void;
}): RegionCycle {
	const { document: doc, focusFrame } = options;

	const regionElement = (name: BuildingRegion) => doc.querySelector<HTMLElement>(`[data-building-region="${name}"]`);

	const current = (): BuildingRegion | null => {
		const active = doc.activeElement;
		if (active instanceof HTMLIFrameElement) return "canvas";
		const found = active?.closest<HTMLElement>("[data-building-region]")?.dataset.buildingRegion;
		return ORDER.find((name) => name === found) ?? null;
	};

	const focus = (name: BuildingRegion) => {
		if (name === "canvas") {
			focusFrame();
			return;
		}
		const region = regionElement(name);
		if (!region) return;
		const first = [
			...region.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), input, select, textarea, [tabindex]"),
		].find((element) => element.tabIndex >= 0 && element.checkVisibility());
		if (first) first.focus();
		else {
			// An empty region still takes its place in the cycle.
			if (!region.hasAttribute("tabindex")) region.tabIndex = -1;
			region.focus();
		}
	};

	return {
		key(event, from) {
			if (event.key !== "F6" || event.altKey || event.ctrlKey || event.metaKey) return false;
			event.preventDefault();
			const at = from ?? current();
			const index = at ? ORDER.indexOf(at) : -1;
			const next =
				index < 0
					? ORDER[event.shiftKey ? ORDER.length - 1 : 0]
					: ORDER[(index + (event.shiftKey ? -1 : 1) + ORDER.length) % ORDER.length];
			if (next) focus(next);
			return true;
		},
		focus,
	};
}
