// The checks every admin screen must pass in a browser: axe-core for WCAG 2.2 A and AA (plus axe's
// best practices), and keyboard use (skip link, visible focus, tab order, no traps).
import { expect } from "bun:test";
import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page } from "playwright";

import { pageErrors } from "./harness.ts";

/** WCAG 2.0, 2.1 and 2.2 at levels A and AA, and axe's best practices. */
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa", "best-practice"];

/** Runs every check on the page as it is now. */
export async function expectAccessibleScreen(page: Page, where: string): Promise<void> {
	await expectNoAxeViolations(page, where);
	await expectKeyboardUsable(page, where);
	expect({ where, errors: pageErrors(page) }).toEqual({ where, errors: [] });
}

/**
 * axe-core finds no violation of WCAG 2.2 A or AA, or of its best practices. `skipRules` names
 * rules that don't apply to the state being checked, each with its reason at the call.
 */
export async function expectNoAxeViolations(page: Page, where: string, skipRules: string[] = []): Promise<void> {
	await nextPaint(page);
	const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).disableRules(skipRules).analyze();
	const violations = results.violations.map((violation) => ({
		rule: violation.id,
		impact: violation.impact,
		help: violation.help,
		elements: violation.nodes.map((node) => `${node.target.join(" ")}: ${node.failureSummary ?? ""}`),
	}));
	expect({ where, violations }).toEqual({ where, violations: [] });
}

type FocusStop = { index: number; label: string; visibleFocus: boolean; inside: boolean };

/**
 * The keyboard reaches everything on the page, in the order it appears, with a visible focus
 * indicator at every stop, starting with a working skip link, and Tab always moves on (no traps).
 */
export async function expectKeyboardUsable(page: Page, where: string): Promise<void> {
	const tabbable = await markTabbableElements(page);
	expect({ where, positiveTabIndex: tabbable.positiveTabIndex }).toEqual({ where, positiveTabIndex: [] });
	expect({ where, stops: tabbable.count }).not.toEqual({ where, stops: 0 });

	await moveFocusToPageStart(page);
	const stops: FocusStop[] = [];
	// Every stop once, then one more Tab must leave the last element: focus never gets stuck.
	for (let press = 0; press <= tabbable.count; press++) {
		await page.keyboard.press("Tab");
		await nextPaint(page);
		stops.push(await currentStop(page));
	}
	const visited = stops.slice(0, tabbable.count);
	const after = stops[tabbable.count];

	expect({ where, first: visited[0]?.label ?? null }).toEqual({ where, first: tabbable.skipLinkLabel });
	expect({ where, order: visited.map((stop) => stop.index) }).toEqual({
		where,
		order: Array.from({ length: tabbable.count }, (_, index) => index),
	});
	expect({
		where,
		withoutVisibleFocus: visited.filter((stop) => !stop.visibleFocus).map((stop) => stop.label),
	}).toEqual({ where, withoutVisibleFocus: [] });
	const stuck = after?.inside === true && after.index === tabbable.count - 1;
	expect({ where, stuckOn: stuck ? after?.label : null }).toEqual({
		where,
		stuckOn: null,
	});

	await expectSkipLinkWorks(page, where);
}

/** The first Tab reaches "Skip to main content", and following it moves focus to the page's main part. */
async function expectSkipLinkWorks(page: Page, where: string): Promise<void> {
	await moveFocusToPageStart(page);
	await page.keyboard.press("Tab");
	await page.keyboard.press("Enter");
	const inMain = await page.evaluate(() => {
		const main = document.getElementById("main");
		return Boolean(main && (document.activeElement === main || main.contains(document.activeElement)));
	});
	expect({ where, skipLinkMovesFocusToMain: inMain }).toEqual({ where, skipLinkMovesFocusToMain: true });
}

/**
 * Opens an overlay (a menu or a dialog) from the keyboard, checks it with axe, then closes it with
 * Escape: focus must return to the control that opened it.
 */
export async function expectOverlayUsable(
	page: Page,
	trigger: Locator,
	overlayRole: "menu" | "dialog",
	where: string,
): Promise<void> {
	await trigger.focus();
	await page.keyboard.press("Enter");
	const overlay = page.getByRole(overlayRole);
	await overlay.waitFor({ state: "visible" });
	await page.waitForTimeout(250);
	// An open menu or dialog is placed at the end of the page, outside the landmarks, as menus and
	// dialogs are: people reach it from the control that opened it, so the landmark rule is skipped.
	await expectNoAxeViolations(page, `${where} (open)`, ["region"]);
	const focusInside = await overlay.evaluate((element) => element.contains(document.activeElement));
	expect({ where, focusMovesIntoOverlay: focusInside }).toEqual({ where, focusMovesIntoOverlay: true });

	await page.keyboard.press("Escape");
	await overlay.waitFor({ state: "hidden" });
	// Focus may come back a frame or two after the overlay hides (a button disabled while its action
	// ran is enabled again first), so it gets a moment to settle.
	const backOnTrigger = await trigger.evaluate((element) => {
		const deadline = performance.now() + 1000;
		return new Promise<boolean>((resolve) => {
			const check = () => {
				if (element === document.activeElement) resolve(true);
				else if (performance.now() > deadline) resolve(false);
				else requestAnimationFrame(check);
			};
			check();
		});
	});
	expect({ where, escapeClosesAndReturnsFocus: backOnTrigger }).toEqual({ where, escapeClosesAndReturnsFocus: true });
}

/**
 * Numbers every element the keyboard should reach, in document order, as `data-tab-stop`: links,
 * buttons and form fields that are rendered and enabled, and one radio button per group.
 */
async function markTabbableElements(page: Page) {
	return page.evaluate(() => {
		const selector = [
			"a[href]",
			"button:not([disabled])",
			"input:not([disabled]):not([type=hidden])",
			"select:not([disabled])",
			"textarea:not([disabled])",
			"summary",
			"[tabindex]",
			"[contenteditable=true]",
		].join(",");
		const rendered = (element: Element) => {
			if (element.closest("[inert], [aria-hidden=true]")) return false;
			const style = getComputedStyle(element);
			return element.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none";
		};
		const radioGroups = new Set<string>();
		const elements = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter((element) => {
			if (element.tabIndex < 0 || element.matches(":disabled") || !rendered(element)) return false;
			if (element instanceof HTMLInputElement && element.type === "radio") {
				const group = element.name;
				const checked = document.querySelector<HTMLInputElement>(`input[type=radio][name="${group}"]:checked`);
				if (checked ? checked !== element : radioGroups.has(group)) return false;
				radioGroups.add(group);
			}
			return true;
		});
		for (const element of document.querySelectorAll("[data-tab-stop]")) element.removeAttribute("data-tab-stop");
		elements.forEach((element, index) => {
			element.dataset.tabStop = String(index);
		});
		const label = (element: HTMLElement) =>
			(element.getAttribute("aria-label") ?? element.textContent ?? element.id).trim().replace(/\s+/g, " ");
		return {
			count: elements.length,
			skipLinkLabel: elements[0] ? label(elements[0]) : null,
			positiveTabIndex: elements.filter((element) => element.tabIndex > 0).map(label),
		};
	});
}

/**
 * Waits until the page has painted twice. Right after a change, a property with a transition still
 * has its old value until the next frame; people only ever see painted frames.
 */
async function nextPaint(page: Page): Promise<void> {
	await page.evaluate(
		() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
	);
}

/** Puts the keyboard's starting point at the top of the page, as after loading it. */
async function moveFocusToPageStart(page: Page): Promise<void> {
	await page.evaluate(() => {
		const marker = document.createElement("span");
		marker.tabIndex = -1;
		document.body.prepend(marker);
		marker.focus();
		marker.remove();
	});
}

async function currentStop(page: Page): Promise<FocusStop> {
	return page.evaluate(() => {
		const element = document.activeElement as HTMLElement | null;
		if (!element || element === document.body) return { index: -1, label: "(page)", visibleFocus: true, inside: false };
		const style = getComputedStyle(element);
		const outline = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
		const ring = style.boxShadow !== "none" && style.boxShadow !== "";
		return {
			index: Number(element.dataset.tabStop ?? -1),
			label: (element.getAttribute("aria-label") ?? element.textContent ?? element.id).trim().replace(/\s+/g, " "),
			visibleFocus: outline || ring,
			inside: true,
		};
	});
}
