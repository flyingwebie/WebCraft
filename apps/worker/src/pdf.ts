// Reports' PDFs (#104): headless Chromium prints WebCraft's own Report page, the same page a Share link
// shows. Only the worker renders: its image carries Chromium (Debian's `chromium` package, BSD-licensed,
// run as a separate program). Node APIs only (ADR 0006).
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { PDF_LIMITS, PdfRenderError, type PdfRenderer, REPORT_PAGE_POLICY } from "@webcraft/core";

/** How long one PDF may take before Chromium is stopped. */
export const CHROMIUM_TIMEOUT_MS = 60_000;

/** The Chromium program, unless `WEBCRAFT_CHROMIUM` names another (the worker image sets it). */
export const DEFAULT_CHROMIUM = "chromium";

export type ChromiumPdfOptions = {
	/** The Chromium (or Chrome) program to run. */
	executable?: string;
	/** How long one PDF may take. */
	timeoutMs?: number;
};

/**
 * A PDF renderer running headless Chromium once per PDF, one at a time per worker (the job takes one
 * at a time), in a temporary folder of its own that is removed afterwards. The page is WebCraft's own
 * and complete in itself, so Chromium is kept from everything else: the page carries its own policy
 * (no script, images only from `data:` addresses), every host name fails to resolve and every request
 * goes to a proxy that isn't there, its profile is thrown away, and it is stopped (with everything it
 * started) after `timeoutMs`. Its JavaScript heap is capped too. The
 * sandbox is off, as Chromium's sandbox can't start inside an unprivileged container; what it prints
 * is never anyone else's page.
 */
export function createChromiumPdf(options: ChromiumPdfOptions = {}): PdfRenderer {
	const executable = options.executable ?? process.env.WEBCRAFT_CHROMIUM ?? DEFAULT_CHROMIUM;
	const timeoutMs = options.timeoutMs ?? CHROMIUM_TIMEOUT_MS;
	return {
		async render(html) {
			if (Buffer.byteLength(html) > PDF_LIMITS.html) throw new PdfRenderError("size", "The page is too large.");
			const folder = await mkdtemp(join(tmpdir(), "webcraft-report-"));
			try {
				const page = join(folder, "report.html");
				const output = join(folder, "report.pdf");
				await writeFile(page, withPolicy(html), { mode: 0o600 });
				await run(executable, chromiumArguments(folder, output, page), timeoutMs);
				const size = await stat(output).then(
					(found) => found.size,
					() => 0,
				);
				if (size === 0) throw new PdfRenderError("failed", "Chromium made no PDF.");
				if (size > PDF_LIMITS.pdf) throw new PdfRenderError("size", "The PDF is too large.");
				const pdf = new Uint8Array(await readFile(output));
				if (Buffer.from(pdf.subarray(0, 5)).toString("latin1") !== "%PDF-") {
					throw new PdfRenderError("failed", "Chromium's answer isn't a PDF.");
				}
				return pdf;
			} finally {
				await rm(folder, { recursive: true, force: true });
			}
		},
	};
}

/** What Chromium is run with: headless, printing one file, kept from the network and from scripts. */
export function chromiumArguments(folder: string, output: string, page: string): string[] {
	return [
		"--headless=new",
		"--no-sandbox",
		"--disable-gpu",
		"--disable-dev-shm-usage",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--disable-background-networking",
		"--disable-component-update",
		"--disable-default-apps",
		"--disable-sync",
		"--mute-audio",
		"--hide-scrollbars",
		"--js-flags=--max-old-space-size=128",
		"--renderer-process-limit=1",
		// Nothing leaves: no name resolves, and every request goes to a proxy that isn't there.
		"--host-resolver-rules=MAP * ~NOTFOUND",
		"--proxy-server=http://127.0.0.1:9",
		"--proxy-bypass-list=<-loopback>",
		`--user-data-dir=${join(folder, "profile")}`,
		"--no-pdf-header-footer",
		`--print-to-pdf=${output}`,
		pathToFileURL(page).href,
	];
}

/**
 * The page with its policy inside it: a file opened from disk has no headers to carry one, so the
 * page's own (no script, its styles by hash, `data:` images) is set by a `<meta>` element first thing.
 * A page with no `<head>` to put it in is refused: Chromium runs without its sandbox here, and the
 * policy is what keeps a page's scripts from running, so no page is printed without it.
 */
export function withPolicy(html: string): string {
	if (!html.includes(HEAD)) throw new PdfRenderError("failed", "The page has no place for its policy.");
	const policy = REPORT_PAGE_POLICY.split(";")
		.map((part) => part.trim())
		// A `<meta>` policy can't say who may frame the page; nothing frames it here anyway.
		.filter((part) => part !== "" && !part.startsWith("frame-ancestors"))
		.join("; ");
	return html.replace(HEAD, `${HEAD}\n<meta http-equiv="Content-Security-Policy" content="${policy}">`);
}

/** Where the policy goes: the opening of the head, as WebCraft's own Report page writes it. */
const HEAD = "<head>";

/** Runs Chromium, stopping it and everything it started after `timeoutMs`. */
function run(executable: string, args: string[], timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		let child: ReturnType<typeof spawn>;
		try {
			// Its own process group, so stopping it stops its helpers too.
			child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"], detached: true });
		} catch (error) {
			reject(new PdfRenderError("unavailable", "Chromium couldn't be started.", { cause: error }));
			return;
		}
		let errors = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			if (errors.length < 4000) errors += chunk.toString();
		});
		const stop = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const timer = setTimeout(() => {
			stop();
			reject(new PdfRenderError("timeout", `Chromium took longer than ${Math.round(timeoutMs / 1000)} seconds.`));
		}, timeoutMs);
		child.on("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			reject(
				new PdfRenderError(
					error.code === "ENOENT" ? "unavailable" : "failed",
					error.code === "ENOENT" ? `There is no Chromium at ${executable}.` : "Chromium couldn't be started.",
					{ cause: error },
				),
			);
		});
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			// Its helpers may outlive it; none is left behind.
			stop();
			if (code === 0) resolve();
			else
				reject(new PdfRenderError("failed", `Chromium stopped (${signal ?? code}).`, { cause: errors.slice(0, 500) }));
		});
	});
}
