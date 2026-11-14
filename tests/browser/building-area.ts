// The building area (ADR 0037) in a real browser: entering it as the admin's way in does, the page in
// its frame, the overlay drawn over it. Its checks run in Chromium, Firefox and WebKit, since editing
// across the frame's edge is where the engines differ most.
import { expect } from "bun:test";
import { EDITOR_LAYOUT_VERSION } from "@webcraft/core";
import { type Browser, type BrowserType, chromium, type Frame, firefox, type Page, webkit } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import type { BrowserInstall, Theme } from "./harness.ts";

export type Engine = "chromium" | "firefox" | "webkit";

export const ENGINES: readonly Engine[] = ["chromium", "firefox", "webkit"];

const TYPES: Record<Engine, BrowserType> = { chromium, firefox, webkit };

/** A page in one engine, with what it reported as errors since it opened. */
export type EnginePage = { page: Page; errors: string[] };

/**
 * Pages in each engine, on the browser Install's web process. Chromium's come from the harness (its
 * error log feeds the accessibility checks); Firefox's and WebKit's are launched here, once each.
 */
export function enginePages(install: BrowserInstall) {
	const launched = new Map<Engine, Promise<Browser>>();
	return {
		async open(engine: Engine, theme: Theme = "light"): Promise<EnginePage> {
			const errors: string[] = [];
			let page: Page;
			if (engine === "chromium") {
				page = await install.newPage(theme);
			} else {
				let browser = launched.get(engine);
				if (!browser) {
					browser = TYPES[engine].launch();
					launched.set(engine, browser);
				}
				const context = await (await browser).newContext({
					colorScheme: theme,
					reducedMotion: "reduce",
					viewport: { width: 1280, height: 900 },
				});
				page = await context.newPage();
			}
			page.on("pageerror", (error) => errors.push(String(error)));
			page.on("console", (message) => {
				if (message.type() !== "error") return;
				// A browser asks for this optional file even when the Site declares no icon.
				const url = message.location().url;
				if (url && new URL(url, page.url()).pathname === "/favicon.ico") return;
				errors.push(`${message.text()} (${url})`);
			});
			return { page, errors };
		},
		async close() {
			await Promise.all([...launched.values()].map(async (browser) => (await browser).close()));
		},
	};
}

/**
 * Enters the building area as the admin's way in does: asks for a link that opens it (as the person,
 * from their admin session) and follows it in the page, on the Site's address the web process serves.
 * Waits until the frame shows the page and the agent has made its regions editable. Unless
 * `firstVisit`, the person has seen client editing's first-visit card already (BA-14), so it covers
 * nothing a check points at.
 */
export async function enterBuildingArea(
	install: BrowserInstall,
	page: Page,
	options: {
		as: TestAccount;
		siteId: string;
		slug: string;
		open?: string;
		returnTo?: string;
		safeMode?: boolean;
		firstVisit?: boolean;
	},
): Promise<Frame> {
	const admin = await install.install.signIn(options.as);
	if (!options.firstVisit) {
		await admin.api.me.saveEditorPreferences({
			siteId: options.siteId,
			preferences: { version: EDITOR_LAYOUT_VERSION, hintSeen: true },
		});
	}
	const { url } = await admin.api.editMode.open({
		siteId: options.siteId,
		building: true,
		...(options.open ? { open: options.open } : {}),
		...(options.returnTo ? { returnTo: options.returnTo } : {}),
		...(options.safeMode ? { safeMode: true } : {}),
	});
	// The link names the test Install's own address for the Site; the web process serves it on `.localhost`.
	const link = new URL(url);
	await page.goto(install.siteUrl(options.slug, `${link.pathname}${link.search}`));
	return frameOf(page);
}

/** The page shown in the shell's frame, once the page agent has started in it. */
export async function frameOf(page: Page): Promise<Frame> {
	await page.locator("iframe[data-wc-frame]").waitFor({ state: "attached" });
	const handle = await page.locator("iframe[data-wc-frame]").elementHandle();
	let frame = await handle?.contentFrame();
	for (let attempt = 0; attempt < 100 && (!frame || frame.url() === "about:blank"); attempt++) {
		await page.waitForTimeout(50);
		frame = await handle?.contentFrame();
	}
	if (!frame) throw new Error("The shell has no frame.");
	await frame.waitForLoadState("load");
	await frame.waitForFunction(
		() => document.querySelector("[data-wc-item][contenteditable]") !== null || document.readyState === "complete",
	);
	return frame;
}

/** Waits for the shell to have drawn whatever the last change asks (two animation frames). */
export async function settled(page: Page): Promise<void> {
	await page.evaluate(
		() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
	);
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * How far an outline the shell drew is from the element it outlines, in pixels of the shell's window
 * (the largest difference of its four edges), the element's box measured by the browser through the
 * frame's offset and zoom. The shell draws again on the next frame after a change, and a frame learns
 * its new size a frame or two after the window does: the outline gets half a second to catch up.
 */
export async function outlineDrift(
	page: Page,
	frame: Frame,
	selector: string,
	outline: "selected" | "hover",
): Promise<number> {
	let last = Number.POSITIVE_INFINITY;
	for (let attempt = 0; attempt < 10 && last > 1; attempt++) {
		if (attempt > 0) await page.waitForTimeout(50);
		await settled(page);
		const element = await frame.locator(selector).boundingBox();
		const drawn = await page.locator(`[data-wc-outline="${outline}"]`).boundingBox();
		if (!element || !drawn) continue;
		last = drift(element, drawn);
	}
	return last;
}

/** Puts the keyboard's starting point in the shell, outside every region (out of the frame, too). */
export async function focusShellStart(page: Page): Promise<void> {
	await page.evaluate(() => {
		const marker = document.createElement("span");
		marker.tabIndex = -1;
		document.body.prepend(marker);
		marker.focus();
		marker.remove();
	});
}

export function drift(a: Box, b: Box): number {
	return Math.max(
		Math.abs(a.x - b.x),
		Math.abs(a.y - b.y),
		Math.abs(a.x + a.width - (b.x + b.width)),
		Math.abs(a.y + a.height - (b.y + b.height)),
	);
}

/** Zooms the frame out to show the page `width` wide in the space it has, by a CSS scale (as the size readout will). */
export async function zoomFrame(page: Page, width: number): Promise<number> {
	const scale = await page.evaluate((wide) => {
		const frame = document.querySelector<HTMLIFrameElement>("iframe[data-wc-frame]");
		const box = frame?.parentElement;
		if (!frame || !box) throw new Error("No frame.");
		const scale = box.clientWidth / wide;
		frame.style.setProperty("width", `${wide}px`);
		frame.style.setProperty("height", `${box.clientHeight / scale}px`);
		frame.style.setProperty("transform", `scale(${scale})`);
		return scale;
	}, width);
	await settled(page);
	return scale;
}

/** The shell's live region (polite or assertive) as it reads now. */
export async function announced(page: Page): Promise<string> {
	return ((await page.locator("[data-wc-messages]").textContent()) ?? "").replaceAll("\u00a0", "").trim();
}

/** Whether focus is shown on the element the shell's focus is on: an outline or a ring. */
export async function shellFocusVisible(page: Page): Promise<boolean> {
	return page.evaluate(() => {
		const element = document.activeElement;
		if (!element || element === document.body) return false;
		const style = getComputedStyle(element);
		const outline = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
		return outline || (style.boxShadow !== "none" && style.boxShadow !== "");
	});
}

/** Expects nothing logged as an error by the page or the frame (axe's own inline-style reports aside). */
export function expectNoErrors(where: string, errors: readonly string[]): void {
	const real = errors.filter((error) => !error.startsWith("Applying inline style violates"));
	expect({ where, errors: real }).toEqual({ where, errors: [] });
}
