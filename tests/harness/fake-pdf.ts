import { type PdfProblem, PdfRenderError, type PdfRenderer } from "@webcraft/core";

/** The first line of every PDF the fake makes: what a real PDF starts with. */
const HEADER = "%PDF-1.7\n% made by the test suite's fake renderer\n";

/**
 * Turns Reports' pages into PDFs without a browser (the worker uses headless Chromium; one test in
 * `tests/reports/chromium.test.ts` runs the real one). Each "PDF" holds the page's text as a reader
 * would see it, after a PDF header, so tests read what a Report says with `pdfText`.
 */
export type FakePdf = {
	readonly renderer: PdfRenderer;
	/** Every page handed to the renderer so far, oldest first. */
	readonly rendered: readonly string[];
	/** From now on every render fails, as Chromium timing out or crashing would. */
	fail(problem?: PdfProblem): void;
	/** Renders work again. */
	work(): void;
};

export function createFakePdf(): FakePdf {
	const rendered: string[] = [];
	let failing: PdfProblem | null = null;
	return {
		rendered,
		fail(problem = "failed") {
			failing = problem;
		},
		work() {
			failing = null;
		},
		renderer: {
			async render(html) {
				rendered.push(html);
				if (failing) throw new PdfRenderError(failing, `The fake renderer is ${failing}.`);
				return new TextEncoder().encode(HEADER + textOf(html));
			},
		},
	};
}

/** The text a fake PDF holds: a page's words, as a reader sees them. */
export function pdfText(pdf: Uint8Array | string): string {
	const text = typeof pdf === "string" ? pdf : new TextDecoder().decode(pdf);
	if (!text.startsWith("%PDF-")) throw new Error("That isn't a PDF.");
	return text.startsWith(HEADER) ? text.slice(HEADER.length) : text;
}

/** A page's visible text: no head, no styles, tags become spaces, entities read. */
export function textOf(html: string): string {
	return html
		.replace(/<head>[\s\S]*?<\/head>/i, " ")
		.replace(/<(script|style|title)[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}
