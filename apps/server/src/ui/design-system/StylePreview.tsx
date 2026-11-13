import { useEffect, useRef, useState } from "react";

import type { ColourMode } from "./model.ts";

/** Where the canvas document is on the admin host: an empty page that runs no script (the visual builder's). */
const CANVAS_URL = "/api/builder/canvas";

/**
 * A live preview of the Design system's Draft: sample markup styled by the Draft's compiled
 * stylesheet (`designSystem.preview`), in the visual builder's canvas frame (on the admin host,
 * sandboxed, its page's policy allowing no script), in light or dark (`data-wc-theme`). The screen
 * writes the markup and the stylesheet in itself, as a constructed stylesheet; `extraCss` styles the
 * samples by data attributes, never by a class a Site could have. The frame is as tall as what it
 * shows and out of the tab order: everything it shows is edited beside it.
 */
export function StylePreview({
	title,
	stylesheet,
	markup,
	extraCss = "",
	mode,
}: {
	/** What the frame shows, for screen readers. */
	title: string;
	stylesheet: string;
	markup: string;
	extraCss?: string;
	mode: ColourMode;
}) {
	const frame = useRef<HTMLIFrameElement>(null);
	const [ready, setReady] = useState(false);

	// The canvas page loads once; it may have loaded before the preview was ready to hear it.
	useEffect(() => {
		const document = frame.current?.contentDocument;
		if (document?.readyState === "complete" && document.URL.endsWith(CANVAS_URL)) setReady(true);
	}, []);

	useEffect(() => {
		const iframe = frame.current;
		const document = iframe?.contentDocument;
		const view = iframe?.contentWindow as (Window & typeof globalThis) | null | undefined;
		if (!ready || !iframe || !document || !view) return;
		document.documentElement.setAttribute("data-wc-theme", mode);
		const sheet = new view.CSSStyleSheet();
		sheet.replaceSync(`${stylesheet}\n${extraCss}\nbody{margin:0;padding:16px}`);
		document.adoptedStyleSheets = [sheet];
		document.body.innerHTML = markup;
		for (const element of document.body.querySelectorAll<HTMLElement>("a, button, input, select, textarea, summary")) {
			element.tabIndex = -1;
		}
		iframe.style.height = `${Math.max(48, document.documentElement.scrollHeight)}px`;
	}, [ready, stylesheet, markup, extraCss, mode]);

	return (
		<iframe
			ref={frame}
			src={CANVAS_URL}
			title={title}
			sandbox="allow-same-origin"
			tabIndex={-1}
			data-design-preview=""
			onLoad={() => setReady(true)}
			className="bg-background block w-full rounded-md border"
		/>
	);
}
