// The worker's real PDF renderer (#104): headless Chromium prints a Report's page, with scripts off and
// nothing fetched from anywhere, within its time limit. Every other Reports test uses the fake
// renderer; this one runs Chromium where it is installed (Playwright's for the browser checks, or
// `WEBCRAFT_CHROMIUM`), and is skipped where it isn't.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { reportPage } from "@webcraft/core";
import { createChromiumPdf } from "@webcraft/worker/pdf";
import { chromium } from "playwright";

const executable = process.env.WEBCRAFT_CHROMIUM ?? chromium.executablePath();
const installed = existsSync(executable);

/** A server that counts what it is asked for: Chromium must ask it nothing. */
let asked = 0;
const server = createServer((_request, response) => {
	asked++;
	response.end("found");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;

afterAll(() => {
	server.close();
});

const page = reportPage({
	language: "en",
	title: "Weekly results",
	placeName: "Bakery",
	brand: {
		agency: { name: "Harbour Digital", logo: null, accent: "#0f766e" },
		client: { name: "Bakery", logo: null },
		madeWith: true,
	},
	period: { from: new Date("2026-03-02T00:00:00Z"), to: new Date("2026-03-09T00:00:00Z") },
	compared: { from: new Date("2026-02-23T00:00:00Z"), to: new Date("2026-03-02T00:00:00Z") },
	widgets: [
		{
			answer: {
				widgetId: "8c5f4b8e-7c0e-4b8e-9b1e-2c1a5f0e9a11",
				title: "Totals",
				range: { from: new Date("2026-03-02T00:00:00Z"), to: new Date("2026-03-09T00:00:00Z"), interval: "day" },
				data: { shape: "number", values: [{ key: "pageviews", label: "Page views", count: 120, of: null }] },
				problem: null,
				countedFrom: null,
				sites: null,
			},
			previous: null,
			text: "Page views were steady.",
		},
	],
	ai: { status: "written", whatHappened: "A steady week.", suggestions: [] },
	explore: null,
});

describe.skipIf(!installed)("headless Chromium", () => {
	test("prints a Report's page as a PDF, fetching nothing and running no script", async () => {
		const outside = `http://127.0.0.1:${port}`;
		const hostile = page.replace(
			"</main>",
			`<img src="${outside}/image.png" alt=""><link rel="stylesheet" href="${outside}/style.css"><script>fetch("${outside}/script")</script></main>`,
		);
		const pdf = await createChromiumPdf({ executable }).render(hostile);

		expect(Buffer.from(pdf.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
		expect(pdf.byteLength).toBeGreaterThan(1000);
		expect(asked).toBe(0);
	});

	test("gives up after its time limit", async () => {
		await expect(createChromiumPdf({ executable, timeoutMs: 1 }).render(page)).rejects.toMatchObject({
			name: "PdfRenderError",
			problem: "timeout",
		});
	});
});

test("a page its policy can't be put into is never printed: Chromium runs unsandboxed, and the policy is what keeps scripts out", async () => {
	// A page whose head isn't written the way the policy is put into it.
	const unusual = page.replace("<head>", '<head data-page="report">');
	expect(unusual).not.toBe(page);

	// Wherever Chromium is: it is never started for such a page.
	await expect(createChromiumPdf({ executable }).render(unusual)).rejects.toMatchObject({
		name: "PdfRenderError",
		problem: "failed",
		message: "The page has no place for its policy.",
	});
});

test("says plainly when there is no Chromium", async () => {
	await expect(createChromiumPdf({ executable: "/nowhere/chromium" }).render(page)).rejects.toMatchObject({
		name: "PdfRenderError",
		problem: "unavailable",
	});
});
