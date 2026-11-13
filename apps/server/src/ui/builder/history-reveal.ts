/** The Inspector tab is view state, captured with a finished action and revealed without focus. */
export function inspectorHistoryTab(): "builder-settings" | "builder-style" {
	return typeof document !== "undefined" &&
		document.getElementById("tab-builder-style")?.getAttribute("aria-selected") === "true"
		? "builder-style"
		: "builder-settings";
}

export function revealInspectorHistory(tab: "builder-settings" | "builder-style" | undefined) {
	if (!tab) return;
	// Tabs' programmatic click selects its panel without focusing the tab button.
	document.getElementById(`tab-${tab}`)?.click();
}
