import type { BarKit } from "../../site/edit-bar/kit.ts";

/**
 * A place on the page for one of Edit mode's own tools: a shadow root holding the tools' stylesheet
 * (the Site's CSS can't reach it) and an element that follows the device's light or dark theme. Null
 * when the document has no window to read the theme from.
 */
export function toolsHost(kit: BarKit, id: string, styles: string): HTMLElement | null {
	const view = kit.doc.defaultView;
	if (!view) return null;
	const host = kit.doc.createElement("div");
	host.id = id;
	kit.doc.body.append(host);
	const shadow = host.attachShadow({ mode: "open" });
	const link = kit.doc.createElement("link");
	link.rel = "stylesheet";
	link.href = styles;
	shadow.append(link);
	const container = kit.doc.createElement("div");
	shadow.append(container);
	const scheme = view.matchMedia("(prefers-color-scheme: dark)");
	const theme = () => {
		container.classList.toggle("dark", scheme.matches);
		container.classList.toggle("light", !scheme.matches);
	};
	theme();
	scheme.addEventListener("change", theme);
	return container;
}
