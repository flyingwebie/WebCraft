/**
 * F6 and Shift+F6 move focus between the building area's regions (ADR 0037): the rail, the docks
 * that are open (left, right, bottom), the frame (the page itself), the bottom bar, and back round.
 * A key pressed in the page reaches here through the page agent, before any Site script sees it.
 */
export type BuildingRegion = "rail" | "left" | "right" | "bottom" | "canvas" | "bar";

const ORDER: readonly BuildingRegion[] = ["rail", "left", "right", "bottom", "canvas", "bar"];

/** The regions that may be absent: a closed dock has no place in the cycle. */
const OPTIONAL: readonly BuildingRegion[] = ["left", "right", "bottom"];

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

	// Each region remembers where focus last was in it (BA-33, "deep memory"): F6 goes back there.
	const memory = new Map<BuildingRegion, HTMLElement>();
	doc.addEventListener("focusin", (event) => {
		const target = event.target;
		if (!(target instanceof HTMLElement) || target instanceof HTMLIFrameElement) return;
		const name = target.closest<HTMLElement>("[data-building-region]")?.dataset.buildingRegion;
		const region = ORDER.find((each) => each === name);
		if (region && region !== "canvas") memory.set(region, target);
	});
	/** The element focus was last on in a region, while it can still take focus there. */
	const remembered = (name: BuildingRegion, region: HTMLElement): HTMLElement | null => {
		const element = memory.get(name);
		return element?.isConnected &&
			region.contains(element) &&
			element.checkVisibility() &&
			!element.closest("[inert]") &&
			!(element as HTMLButtonElement).disabled
			? element
			: null;
	};

	const current = (): BuildingRegion | null => {
		const active = doc.activeElement;
		if (active instanceof HTMLIFrameElement) return "canvas";
		const found = active?.closest<HTMLElement>("[data-building-region]")?.dataset.buildingRegion;
		return ORDER.find((name) => name === found) ?? null;
	};

	/** The regions drawn now, in order. A dock under an open place is drawn but inert: it is not in the cycle. */
	const present = () =>
		ORDER.filter((name) => {
			if (!OPTIONAL.includes(name)) return true;
			const region = regionElement(name);
			return region !== null && region.closest("[inert]") === null;
		});

	const focus = (name: BuildingRegion) => {
		if (name === "canvas") {
			focusFrame();
			return;
		}
		const region = regionElement(name);
		if (!region) return;
		const last = remembered(name, region);
		if (last) {
			last.focus();
			return;
		}
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
			// A modal dialog keeps focus: F6 moves nowhere while one is open (BA-33).
			if (doc.querySelector("dialog[open]:modal")) return true;
			const at = from ?? current();
			const order = present();
			const index = at ? order.indexOf(at) : -1;
			const next =
				index < 0
					? order[event.shiftKey ? order.length - 1 : 0]
					: order[(index + (event.shiftKey ? -1 : 1) + order.length) % order.length];
			if (next) focus(next);
			return true;
		},
		focus,
	};
}
