export type EditorRegion = "tree" | "inspector" | "html" | "css" | "js" | "topbar";
export type AnnouncementPriority = "polite" | "interrupt" | "silent";
export type EditorRegionLayout = {
	/** Mounted regions which this layout can reveal, such as closed drawers. */
	hiddenRegions(): readonly EditorRegion[];
	reveal(name: EditorRegion, focus: () => void): void;
};
export type EditorAccessibility = {
	announce(text: string, priority?: AnnouncementPriority): void;
	registerRegionLayout(layout: EditorRegionLayout): () => void;
	/** The preview iframe forwards its keys here; the document listener uses the same controller. */
	handleRegionKey(event: KeyboardEvent): boolean;
	focusRegion(name: EditorRegion): void;
	focusSelectedRow(): void;
	selectedRow(): HTMLElement | null;
};

/** Shared by both canvases and injected as source into the Edit bar and Code mode assets.
 * Keep this factory self-contained: those assets cannot capture module imports. */
export function editorAccessibility(doc: Document): EditorAccessibility {
	const owner = doc as Document & { webcraftEditorAccessibility?: EditorAccessibility };
	if (owner.webcraftEditorAccessibility) return owner.webcraftEditorAccessibility;
	const order = ["tree", "inspector", "html", "css", "js", "topbar"] as const;
	const memory = new Map<string, { element: HTMLElement; selector: string | null }>();
	const watchedRoots = new WeakSet<ShadowRoot>();
	let layout: EditorRegionLayout | undefined;
	const deep = (root: Document | ShadowRoot): Element | null => {
		const active = root.activeElement;
		return active?.shadowRoot ? (deep(active.shadowRoot) ?? active) : active;
	};
	const all = (selector: string, root: Document | ShadowRoot | HTMLElement = doc): HTMLElement[] => {
		const result = [...root.querySelectorAll<HTMLElement>(selector)];
		for (const element of root.querySelectorAll("*"))
			if (element.shadowRoot) {
				// Focus moving within a shadow root can leave the document's retargeted focus unchanged.
				if (!watchedRoots.has(element.shadowRoot)) {
					watchedRoots.add(element.shadowRoot);
					element.shadowRoot.addEventListener("focusin", remember, true);
				}
				result.push(...all(selector, element.shadowRoot));
			}
		return result;
	};
	const visible = (element: HTMLElement): boolean => {
		if (
			!element.isConnected ||
			!element.checkVisibility({ checkVisibilityCSS: true }) ||
			element.closest('[inert], [hidden], [aria-hidden="true"]')
		)
			return false;
		const root = element.getRootNode();
		return !(root instanceof ShadowRoot) || visible(root.host as HTMLElement);
	};
	const usable = (element: HTMLElement) => visible(element) && !element.matches(":disabled");
	const regions = () => all("[data-editor-region]").filter(visible);
	const modal = () => all('[aria-modal="true"], [role="dialog"], [role="alertdialog"], dialog[open]').some(visible);
	const selectedRow = () => {
		const tree = regions().find((region) => region.dataset.editorRegion === "tree");
		// An action must wait for its selected descendant to be revealed, never select its ancestor instead.
		if (tree?.querySelector('[role="tree"][data-selection-hidden]')) return null;
		return (
			tree?.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]') ??
			tree?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') ??
			tree?.querySelector<HTMLElement>("button:not(:disabled)") ??
			null
		);
	};
	const reveal = (name: EditorRegion, focus: () => void) => {
		if (modal()) return;
		const ready = () => {
			if (!modal()) focus();
		};
		if (layout) layout.reveal(name, ready);
		else ready();
	};
	const focusRegion = (name: EditorRegion) =>
		reveal(name, () => {
			const region = regions().find((each) => each.dataset.editorRegion === name);
			if (!region) return;
			const remembered = memory.get(name);
			const previous = remembered?.element.isConnected
				? remembered.element
				: remembered?.selector
					? region.querySelector<HTMLElement>(remembered.selector)
					: null;
			const preferred =
				name === "tree"
					? (selectedRow() ?? region.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]'))
					: region.querySelector<HTMLElement>("[data-editor-default-focus]");
			const target =
				previous && region.contains(previous) && usable(previous)
					? previous
					: preferred && usable(preferred)
						? preferred
						: [...region.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]")].find(
								(each) => each.tabIndex >= 0 && usable(each),
							);
			if (target) target.focus();
			else {
				// Empty or read-only panels still take their place in the region cycle.
				if (!region.hasAttribute("tabindex")) region.tabIndex = -1;
				region.focus();
			}
		});
	const remember = () => {
		const active = deep(doc);
		if (!(active instanceof HTMLElement)) return;
		for (const region of regions())
			if (region.contains(active)) {
				const attribute = ["data-row-key", "id", "aria-label", "name"].find((name) => active.hasAttribute(name));
				memory.set(region.dataset.editorRegion ?? "", {
					element: active,
					selector: attribute ? `[${attribute}="${CSS.escape(active.getAttribute(attribute) ?? "")}"]` : null,
				});
			}
	};
	const handleRegionKey = (event: KeyboardEvent) => {
		remember();
		if (event.key !== "F6" || event.altKey || event.ctrlKey || event.metaKey) return false;
		if (!all("[data-editor-region]").length) return false;
		event.preventDefault();
		event.stopPropagation();
		if (modal()) return true;
		const hidden = layout?.hiddenRegions() ?? [];
		const available = all("[data-editor-region]").filter(
			(region) => visible(region) || hidden.includes(region.dataset.editorRegion as EditorRegion),
		);
		const active = deep(doc);
		const names = order.filter((name) => available.some((region) => region.dataset.editorRegion === name));
		const current = available.find((region) => active && region.contains(active))?.dataset.editorRegion;
		const index = names.indexOf(current as EditorRegion);
		const next =
			index < 0
				? names[event.shiftKey ? names.length - 1 : 0]
				: names[(index + (event.shiftKey ? -1 : 1) + names.length) % names.length];
		if (next) focusRegion(next);
		return true;
	};
	doc.addEventListener("focusin", remember, true);
	doc.addEventListener("pointerdown", remember, true);
	doc.addEventListener("keydown", handleRegionKey, true);
	const messages = doc.createElement("div");
	messages.dataset.editorMessages = "";
	messages.className = "sr-only wc-editor-messages";
	const polite = doc.createElement("p");
	polite.setAttribute("role", "status");
	polite.setAttribute("aria-live", "polite");
	polite.setAttribute("aria-atomic", "true");
	const urgent = doc.createElement("p");
	urgent.setAttribute("role", "alert");
	urgent.setAttribute("aria-live", "assertive");
	urgent.setAttribute("aria-atomic", "true");
	messages.append(polite, urgent);
	// Document-level live regions stay exposed when a modal hides sibling editor shadow roots.
	doc.body.append(messages);
	let count = 0;
	const api: EditorAccessibility = {
		announce(text, priority = "polite") {
			if (!text || priority === "silent") return;
			if (!messages.isConnected) doc.body.append(messages);
			const target = priority === "interrupt" ? urgent : polite;
			(priority === "interrupt" ? polite : urgent).textContent = "";
			// Alternating whitespace makes repeated actions observable without delaying or reordering them.
			target.textContent = `${text}${++count % 2 ? "\u00a0" : ""}`;
		},
		registerRegionLayout(next) {
			layout = next;
			return () => {
				if (layout === next) layout = undefined;
			};
		},
		handleRegionKey,
		focusRegion,
		selectedRow,
		focusSelectedRow() {
			reveal("tree", () => selectedRow()?.focus());
		},
	};
	owner.webcraftEditorAccessibility = api;
	return api;
}
