import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright";
import { expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, pageErrors, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let sequence = 0;
beforeAll(async () => {
	install = await startBrowserInstall();
	await (await install.install.superadmin()).api.modules.approve({ moduleId: "popups", version: "1.0.0" });
});
afterAll(async () => {
	await install.close();
});

async function scene(barPosition: "top" | "bottom", barBehavior: "push" | "overlay") {
	const { api } = await install.install.superadmin();
	const workspace = await install.install.createWorkspace();
	const slug = `popup-bar-${++sequence}`;
	const siteId = (await install.install.createSite(workspace.id, { slug })).id;
	const { popup } = await api.popups.create({ siteId, name: "Offer", key: "offer" });
	await api.popups.saveDraft({
		siteId,
		popupId: popup.id,
		popup: { layout: "bar", barPosition, barBehavior, trigger: { kind: "load" } },
	});
	await api.popups.saveContent({
		siteId,
		popupId: popup.id,
		values: {
			title: "Offer",
			text: "An offer with enough detail to wrap on a phone and stay readable in either placement.",
			enabled: true,
		},
	});
	await api.popups.publish({ siteId, popupId: popup.id });
	await api.popups.publishContent({ siteId, popupId: popup.id });
	const { postType } = await api.postTypes.create({ siteId, name: "Offers", urlPattern: "/offers/{slug}" });
	const { template } = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: `<h1>{{ title }}</h1>${"<p>Read more about this offer.</p>".repeat(60)}{{@consentSettings}}`,
	});
	await api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await api.entries.create({ siteId, postTypeId: postType.id, title: "Offers", slug: "today" });
	await api.entries.publish({ siteId, entryId: entry.id });
	await install.goLive(siteId);
	return { api, siteId, popupId: popup.id, workspaceId: workspace.id, url: install.liveUrl(slug, "/offers/today") };
}

const flow = (page: Page) =>
	page.evaluate(() => ({
		top: (document.querySelector("h1")?.getBoundingClientRect().top ?? 0) + scrollY,
		height: document.body.scrollHeight,
	}));

for (const theme of THEMES)
	for (const phone of [false, true])
		for (const position of ["top", "bottom"] as const)
			for (const behavior of ["push", "overlay"] as const)
				test(`Bar ${position} ${behavior} reserves only its own space after Consent (${theme}, ${phone ? "phone" : "desktop"})`, async () => {
					const fixture = await scene(position, behavior);
					const page = await install.newPage(theme);
					if (phone) await page.setViewportSize({ width: 390, height: 844 });
					await page.goto(fixture.url);
					await page.getByRole("button", { name: "Reject all", exact: true }).waitFor();
					const before = await flow(page);
					expect(await page.getByRole("dialog", { name: "Offer", exact: true }).count()).toBe(0);
					await page.getByRole("button", { name: "Reject all", exact: true }).click();
					const dialog = page.getByRole("dialog", { name: "Offer", exact: true });
					await dialog.waitFor();
					const box = await dialog.boundingBox();
					expect(box).not.toBeNull();
					const height = box?.height ?? 0;
					const viewport = page.viewportSize();
					expect(
						Math.abs(position === "top" ? (box?.y ?? -1) : (viewport?.height ?? 0) - (box?.y ?? 0) - height),
					).toBeLessThan(1);
					const opened = await flow(page);
					expect(
						Math.abs(opened.top - before.top - (behavior === "push" && position === "top" ? height : 0)),
					).toBeLessThan(1);
					expect(Math.abs(opened.height - before.height - (behavior === "push" ? height : 0))).toBeLessThan(1);
					await expectNoAxeViolations(page, `Bar ${position} ${behavior} ${theme} ${phone}`);
					await dialog.getByRole("button", { name: "Close", exact: true }).focus();
					await page.keyboard.press("Escape");
					await dialog.waitFor({ state: "detached" });
					expect(await flow(page)).toEqual(before);
					expect(pageErrors(page)).toEqual([]);
					await page.close();
				});

test("a push Bar follows content size and releases its space before the next Bar mounts", async () => {
	const fixture = await scene("top", "push");
	const { api, siteId } = fixture;
	install.install.clock.advance(1);
	const { popup } = await api.popups.create({ siteId, name: "Next offer", key: "next" });
	await api.popups.saveDraft({
		siteId,
		popupId: popup.id,
		popup: { layout: "bar", barPosition: "bottom", barBehavior: "push", trigger: { kind: "load" } },
	});
	await api.popups.saveContent({ siteId, popupId: popup.id, values: { title: "Next offer", enabled: true } });
	await api.popups.publish({ siteId, popupId: popup.id });
	await api.popups.publishContent({ siteId, popupId: popup.id });
	const page = await install.newPage("light");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(fixture.url);
	await page.getByRole("button", { name: "Reject all", exact: true }).waitFor();
	await page.getByRole("button", { name: "Reject all", exact: true }).click();
	const first = page.getByRole("dialog", { name: "Offer", exact: true });
	await first.waitFor();
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.waitForFunction(
		() => {
			const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");
			const main = document.querySelector("main");
			return dialog && main && Math.abs(main.getBoundingClientRect().top - dialog.offsetHeight) < 1;
		},
		undefined,
		{ timeout: 5000 },
	);
	await first.evaluate((element) => element.remove());
	const next = page.getByRole("dialog", { name: "Next offer", exact: true });
	await next.waitFor();
	const nextBox = await next.boundingBox();
	const main = page.getByRole("main");
	expect(
		Math.abs((await flow(page)).height - ((await main.boundingBox())?.height ?? 0) - (nextBox?.height ?? 0)),
	).toBeLessThan(1);
	await page.keyboard.press("Escape");
	await next.waitFor({ state: "detached" });
	expect(Math.abs((await flow(page)).height - ((await main.boundingBox())?.height ?? 0))).toBeLessThan(1);
	await page.goto("about:blank");
	expect(await page.getByRole("dialog").count()).toBe(0);
	expect(pageErrors(page)).toEqual([]);
	await page.close();
});

for (const theme of THEMES)
	for (const phone of [false, true])
		test(`Staff choose Bar placement and page flow from the keyboard (${theme}, ${phone ? "phone" : "desktop"})`, async () => {
			const fixture = await scene("top", "push");
			const staff = (await install.install.createStaff({ workspaces: [fixture.workspaceId] })).account;
			const page = await install.newPage(theme);
			if (phone) await page.setViewportSize({ width: 390, height: 844 });
			await install.signIn(page, staff);
			await page.goto(install.adminUrl(`/sites/${fixture.siteId}/popups`));
			const position = page.getByRole("combobox", { name: "Bar position", exact: true });
			await position.waitFor({ timeout: 5000 });
			await position.focus();
			await page.keyboard.press("b");
			expect(await position.inputValue()).toBe("bottom");
			await page.getByRole("combobox", { name: "Page flow", exact: true }).focus();
			await page.keyboard.press("o");
			expect(await page.getByRole("combobox", { name: "Page flow", exact: true }).inputValue()).toBe("overlay");
			await expectNoAxeViolations(page, `Bar controls ${theme} ${phone}`);
			await page.getByRole("button", { name: "Save Draft", exact: true }).last().click();
			await page.getByRole("status").filter({ hasText: "Draft saved" }).waitFor();
			const saved = await fixture.api.popups.get({ siteId: fixture.siteId, popupId: fixture.popupId });
			expect(saved.popup.draft).toMatchObject({ barPosition: "bottom", barBehavior: "overlay" });
			expect(saved.popup.published).toMatchObject({ barPosition: "top", barBehavior: "push" });
			await page.getByRole("combobox", { name: "Layout", exact: true }).selectOption("modal");
			expect(await position.count()).toBe(0);
			expect(pageErrors(page)).toEqual([]);
			await page.close();
		});

test("real navigation releases an open push Bar's page space during teardown", async () => {
	const fixture = await scene("top", "push");
	const page = await install.newPage("light");
	await page.goto(fixture.url);
	await page.getByRole("button", { name: "Reject all", exact: true }).waitFor();
	const before = await flow(page);
	await page.getByRole("button", { name: "Reject all", exact: true }).click();
	await page.getByRole("dialog", { name: "Offer", exact: true }).waitFor();
	expect((await flow(page)).top).toBeGreaterThan(before.top);
	// Observe the real pagehide after the Module's own listener, before this document disappears.
	await page.evaluate(() => {
		window.addEventListener(
			"pagehide",
			() => {
				sessionStorage.setItem(
					"popup-pagehide-observation",
					JSON.stringify({
						dialogs: document.querySelectorAll("dialog[open]").length,
						top: (document.querySelector("h1")?.getBoundingClientRect().top ?? 0) + scrollY,
						height: document.body.scrollHeight,
					}),
				);
			},
			{ once: true },
		);
	});
	await page.goto(`${fixture.url}?next=1`);
	const observed = await page.evaluate(() =>
		JSON.parse(sessionStorage.getItem("popup-pagehide-observation") ?? "null"),
	);
	expect(observed).toEqual({ dialogs: 0, ...before });
	expect(pageErrors(page)).toEqual([]);
	await page.close();
});
