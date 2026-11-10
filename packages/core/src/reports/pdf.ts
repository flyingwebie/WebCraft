/**
 * Turning a Report's page into a PDF: a port, because only the worker has a headless Chromium
 * (`createChromiumPdf` in `apps/worker`), the web process and server commands never render one, and
 * tests answer with a fake. The page given is WebCraft's own (`reportPage`), complete in itself: no
 * script, its styles and images inside it, nothing to fetch.
 */

/**
 * Why a page wasn't turned into a PDF: `timeout` (it took longer than allowed), `size` (the page or the
 * PDF is larger than allowed), `failed` (the renderer stopped or answered nothing), `unavailable` (this
 * process has no renderer).
 */
export type PdfProblem = "timeout" | "size" | "failed" | "unavailable";

export class PdfRenderError extends Error {
	override name = "PdfRenderError";
	readonly problem: PdfProblem;
	constructor(problem: PdfProblem, message: string, options?: ErrorOptions) {
		super(message, options);
		this.problem = problem;
	}
}

export type PdfRenderer = {
	/** The page as an A4 PDF; rejects with `PdfRenderError`, never half a document. */
	render(html: string): Promise<Uint8Array>;
};

/** The largest page handed to the renderer, and the largest PDF kept, in bytes. */
export const PDF_LIMITS = { html: 4 * 1024 * 1024, pdf: 20 * 1024 * 1024 } as const;

/** What the web process and server commands have: Reports are rendered by the worker only. */
export const pdfOnlyInWorker: PdfRenderer = {
	render: () => Promise.reject(new PdfRenderError("unavailable", "Reports are rendered by the worker only.")),
};
