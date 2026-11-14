import { type ReactNode, type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { forShadowRoot, PAGE_ATTRIBUTE } from "./site-styles.ts";

/**
 * Before the Site's styles: what a page has when the Site says nothing (the system's colours and
 * font), so the Form never takes the dark chrome's colours around it. In a layer of its own, named
 * before the Site's, so every style of the Site wins over it.
 */
const BASE_CSS = `
:host{all:initial;display:block;color-scheme:light}
@layer wcb-base{[${PAGE_ATTRIBUTE}]{display:block;background-color:Canvas;color:CanvasText;font:16px/1.5 system-ui,sans-serif}}
`;

/**
 * After the Site's styles, and in no layer (so above every layer of the Site's): only the sheet's own
 * box (680 wide, 24 in, radius 14: `forms-builder/01`) and the builder's marks on the fields, by the builder's own attributes (`data-wcb-…`), never a class a Site
 * could have. The selection is the canvas's indigo (SPEC 4), its focus ring the chrome's orange.
 */
const BUILDER_CSS = `
[${PAGE_ATTRIBUTE}]{box-sizing:border-box;inline-size:680px;max-inline-size:100%;margin:0 auto;padding:24px;border-radius:14px;min-block-size:120px}
[data-wcb-index]{position:relative}
[data-wcb-index][data-wcb-selected]{background-color:#4f46e512;box-shadow:0 0 0 8px #4f46e512;outline:2px solid #6366f1;outline-offset:8px;border-radius:2px}
[data-wcb-index][data-wcb-problem]{outline:2px solid #dc2626;outline-offset:8px;border-radius:2px}
[data-wcb-list]:not([data-wcb-dragging]) [data-wcb-index]:not([data-wcb-selected]):hover{outline:1px dashed #6366f1aa;outline-offset:8px;border-radius:2px}
[data-wcb-index][data-wcb-lifted]{opacity:.45}
[data-wcb-hit]{position:absolute;inset:-8px;z-index:1;border-radius:10px;cursor:pointer;outline:none}
[data-wcb-section]>[data-wcb-hit]{z-index:0}
[data-wcb-hit]:focus-visible{box-shadow:0 0 0 2px #fb923c}
[data-wcb-grip]{position:absolute;inset-inline-start:-38px;inset-block-start:calc(50% - 10px);z-index:2;display:none;place-items:center;inline-size:20px;block-size:20px;border-radius:5px;background:#6366f1;color:#fff;box-shadow:0 2px 6px rgba(0,0,0,.4);cursor:grab;touch-action:none}
[data-wcb-index]:hover>[data-wcb-grip],[data-wcb-index][data-wcb-selected]>[data-wcb-grip]{display:grid}
[data-wcb-list][data-wcb-dragging] [data-wcb-grip]{display:none}
[data-wcb-width]{position:absolute;inset-inline-end:-11px;inset-block-start:calc(50% - 14px);z-index:2;display:none;inline-size:6px;block-size:28px;border-radius:3px;background:#6366f1;box-shadow:0 2px 6px rgba(0,0,0,.4);cursor:ew-resize;touch-action:none}
[data-wcb-index][data-wcb-selected]>[data-wcb-width]{display:block}
[data-wcb-readout]{position:absolute;inset-inline-end:-12px;inset-block-start:calc(50% + 20px);z-index:3;padding:3px 8px;border-radius:5px;background:#6366f1;color:#fff;font:600 11px/1.2 system-ui,sans-serif;white-space:nowrap}
[data-wcb-add]{position:absolute;inset-inline:0;inset-block-end:calc(-0.5em - 10px);z-index:3;display:none;align-items:center;block-size:20px;cursor:pointer}
[data-wcb-add]::before{content:"";flex:1;border-block-start:1px solid #52525b}
[data-wcb-add]>span{display:grid;place-items:center;inline-size:20px;block-size:20px;border-radius:999px;background:#27272a;color:#fff;margin-inline:6px}
[data-wcb-add]::after{content:"";flex:1;border-block-start:1px solid #52525b}
[data-wcb-list]:not([data-wcb-dragging]) [data-wcb-index]:hover>[data-wcb-add]{display:flex}
[data-wcb-chip]{display:inline-flex;align-items:center;gap:5px;justify-self:start;inline-size:max-content;max-inline-size:100%;margin-block-end:2px;padding:3px 8px;border-radius:999px;background:#1e293b;color:#e0e7ff;font:500 10px/1.3 system-ui,sans-serif}
[data-wcb-chip] svg{flex:none}
[data-wcb-hidden-row]{display:flex;align-items:center;gap:8px;padding:6px 12px;border:1px dashed currentColor;border-radius:6px;opacity:.75;font-size:.875em}
[data-wcb-note]{margin:0;font:400 12px/1.4 system-ui,sans-serif;opacity:.7}
[data-wcb-empty]{display:grid;place-items:center;min-block-size:96px;border:1px dashed currentColor;border-radius:8px;opacity:.6;font-size:.875em;text-align:center;padding:12px}
@media (prefers-reduced-motion:no-preference){[data-wcb-index]{transition:background-color .15s ease-in-out,outline-color .15s ease-in-out}}
`;

/** What the canvas reads of the sheet: its shadow root, for the boxes a drop is placed among. */
export type SheetHandle = { root: ShadowRoot | null };

/**
 * The Form's sheet on the Build tab (SPEC 15.2: "the Form as visitors will see it, on a page sheet
 * with the Site's own styles"): a shadow root of the shell holding the Site's Draft stylesheet (its
 * tokens, base styles, Form hooks and custom CSS), the builder's marks after it, and what the canvas
 * draws in it. The Site's styles reach only the sheet, and the shell's never reach it. They are
 * constructed stylesheets (the shell's policy allows no style element); the Site's `@font-face` rules
 * go to the shell's document, where fonts are found. The page is always shown light here.
 */
export function Sheet({
	stylesheet,
	language,
	direction,
	label,
	panel,
	handle,
	children,
}: {
	/** The Site's Draft stylesheet (`designSystem.preview`), or null while it is read. */
	stylesheet: string | null;
	/** The language the Form is shown in (the Site's Default language), and its direction. */
	language: string;
	direction: "ltr" | "rtl";
	/** What the sheet shows, for screen readers. */
	label: string;
	/** When the Form has steps, the sheet is the panel of the step tab shown: its id and that tab's. */
	panel?: { id: string; tab: string } | null;
	handle?: Ref<SheetHandle>;
	children: ReactNode;
}) {
	const host = useRef<HTMLDivElement>(null);
	const [root, setRoot] = useState<ShadowRoot | null>(null);
	useImperativeHandle(handle, () => ({ root }), [root]);

	useLayoutEffect(() => {
		const element = host.current;
		if (!element) return;
		setRoot(element.shadowRoot ?? element.attachShadow({ mode: "open" }));
	}, []);

	useEffect(() => {
		if (!root) return;
		const { css, fontFaces } = forShadowRoot(stylesheet ?? "");
		const sheets = [BASE_CSS, css, BUILDER_CSS].map((text) => {
			const sheet = new CSSStyleSheet();
			sheet.replaceSync(text);
			return sheet;
		});
		root.adoptedStyleSheets = sheets;
		if (!fontFaces) return;
		const fonts = new CSSStyleSheet();
		fonts.replaceSync(fontFaces);
		document.adoptedStyleSheets = [...document.adoptedStyleSheets, fonts];
		return () => {
			document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== fonts);
		};
	}, [root, stylesheet]);

	return (
		<div
			ref={host}
			{...(panel
				? { id: panel.id, role: "tabpanel", "aria-labelledby": panel.tab }
				: { role: "region", "aria-label": label })}
			data-wc-theme="light"
			data-wcb-sheet=""
			data-wcb-styled={stylesheet === null ? undefined : ""}
			className="w-full"
		>
			{root
				? createPortal(
						<div {...{ [PAGE_ATTRIBUTE]: "" }} lang={language} dir={direction}>
							{children}
						</div>,
						root,
					)
				: null}
		</div>
	);
}
