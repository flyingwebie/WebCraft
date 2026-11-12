import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ApiClient } from "@webcraft/api";
import type { Page } from "playwright";
import { photo, upload } from "../harness/images.ts";
import { expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES, type Theme } from "./harness.ts";

let install: BrowserInstall;
beforeEach(async () => {
	install = await startBrowserInstall();
});
afterEach(async () => {
	await install.close();
});
type Props = NonNullable<Parameters<ApiClient["components"]["create"]>[0]["props"]>;
async function fixture(props: Props, values: Record<string, unknown> = {}) {
	const staff = await install.install.superadmin();
	const workspaceId = (await install.install.createWorkspace()).id;
	const siteId = (await install.install.createSite(workspaceId)).id;
	const member = await install.install.createMember({ workspaceId, role: "editor" });
	const peer = await install.install.createMember({ workspaceId, role: "editor" });
	const pageType = (await staff.api.postTypes.list({ siteId })).postTypes.find((p) => p.builtIn === "page");
	if (!pageType) throw new Error("Missing Pages");
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: pageType.id, title: "Props" });
	await staff.api.pages.setHomePage({ siteId, pageId: entry.id });
	const { component } = await staff.api.components.create({ siteId, name: "Hero", props });
	await staff.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: "<section><h1>Shared Props</h1></section>",
	});
	await staff.api.components.publish({ siteId, componentId: component.id });
	await staff.api.pageLayouts.configure({ siteId, enabled: true, allowedComponents: [component.id] });
	const original = await staff.api.pageLayouts.get({ siteId, entryId: entry.id });
	await staff.api.pageLayouts.save({
		siteId,
		entryId: entry.id,
		basedOn: original.version,
		layout: { placements: [{ id: "hero", component: component.id, props: component.draft.props, values }] },
	});
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	const input = { siteId, entryId: entry.id };
	return {
		staff,
		member,
		peer,
		component,
		input,
		read: () => staff.api.pageLayouts.get(input),
		async change(edit: (layout: typeof original.layout) => void) {
			const current = await peer.browser.api.pageLayouts.get(input);
			edit(current.layout);
			return peer.browser.api.pageLayouts
				.save({ ...input, basedOn: current.version, layout: current.layout })
				.catch((error) => {
					throw new Error("Peer save refused", { cause: error });
				});
		},
	};
}
type Site = Awaited<ReturnType<typeof fixture>>;
async function enter(
	site: Site,
	theme: Theme,
	peer = false,
	phone = false,
	beforeOpen?: (page: Page) => Promise<void>,
) {
	const page = await install.newPage(theme, { touch: phone });
	page.setDefaultTimeout(10000);
	if (beforeOpen) await beforeOpen(page);
	if (phone) await page.setViewportSize({ width: 390, height: 844 });
	await install.signIn(page, (peer ? site.peer : site.member).account);
	await page.goto(install.adminUrl(`/sites/${site.input.siteId}`));
	await page.getByRole("button", { name: "Edit on site" }).click();
	await page.waitForURL((url) => url.hostname !== new URL(install.adminUrl("/")).hostname);
	await page.getByRole("button", { name: "Page layout", exact: true }).click();
	await page.getByRole("button", { name: "Props", exact: true }).click();
	return page;
}
const field = (page: Page, name: string) =>
	page.locator('[data-editor-region="inspector"]').getByLabel(name, { exact: true });
async function valueIs(page: Page, name: string, value: string) {
	const id = await field(page, name).getAttribute("id");
	await page.waitForFunction(
		({ id, value }) => {
			const input = document.querySelector("#webcraft-page-layout")?.shadowRoot?.getElementById(id ?? "");
			return input instanceof HTMLInputElement && input.value === value;
		},
		{ id, value },
		{ timeout: 8000 },
	);
}
async function savedValues(site: Site, expected: unknown) {
	const deadline = Date.now() + 8000;
	let actual: unknown;
	do {
		actual = (await site.read()).placements[0]?.values;
		if (JSON.stringify(actual) === JSON.stringify(expected)) break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	} while (Date.now() < deadline);
	expect(actual).toEqual(expected);
}
async function captureActions(page: Page) {
	await page.addInitScript(() => {
		const host = window as unknown as { layoutSteps: string[] };
		host.layoutSteps = [];
		document.addEventListener("webcraft:page-layout", (event) => {
			const controller = (event as CustomEvent<{ finished(listener: (step: unknown) => void): () => void }>).detail;
			controller.finished((step) => host.layoutSteps.push(JSON.stringify(step)));
		});
	});
}
async function ownSteps(page: Page) {
	return page.evaluate(() =>
		(window as unknown as { layoutSteps: string[] }).layoutSteps.map((step) => JSON.parse(step)),
	);
}
for (const theme of THEMES) {
	test(`pending Group leaves retain peer changes and focus (${theme})`, async () => {
		const site = await fixture([
			{
				key: "group",
				label: "Group",
				type: "group",
				fields: [
					{ key: "first", label: "First", type: "text", default: "First baseline" },
					{ key: "second", label: "Second", type: "text", default: "Second baseline" },
				],
			},
		]);
		const page = await enter(site, theme, false, false, captureActions);
		const peer = await enter(site, theme, true);
		try {
			await field(page, "First").fill("Own first");
			await field(peer, "Second").fill("Peer second");
			await field(peer, "Second").press("Tab");
			await valueIs(page, "Second", "Peer second");
			expect(await field(page, "First").inputValue()).toBe("Own first");
			expect(await field(page, "First").evaluate((el) => (el.getRootNode() as ShadowRoot).activeElement === el)).toBe(
				true,
			);
			expect(await ownSteps(page)).toEqual([]);
			await field(page, "First").press("Tab");
			await savedValues(site, { group: { first: "Own first", second: "Peer second" } });
			await page.waitForFunction(() => (window as unknown as { layoutSteps: string[] }).layoutSteps.length === 1);
			expect(await ownSteps(page)).toMatchObject([
				{
					before: {
						placements: [
							{ values: { group: { values: { first: { en: "First baseline" }, second: { en: "Peer second" } } } } },
						],
					},
					after: {
						placements: [
							{ values: { group: { values: { first: { en: "Own first" }, second: { en: "Peer second" } } } } },
						],
					},
					draft: {
						before: { layout: { placements: [{ id: "hero" }] } },
						after: { layout: { placements: [{ id: "hero" }] } },
					},
					selection: "hero",
					panel: "inspector",
				},
			]);
			await page.reload();
			await page.getByRole("button", { name: "Page layout", exact: true }).click();
			await page.getByRole("button", { name: "Props", exact: true }).click();
			await valueIs(page, "Second", "Peer second");
		} finally {
			await page.close();
			await peer.close();
		}
	});
}

for (const theme of THEMES) {
	test(`simultaneous independent Page Props survive delayed peer feeds (${theme})`, async () => {
		const site = await fixture([
			{ key: "first", label: "First", type: "text", default: "First baseline" },
			{ key: "second", label: "Second", type: "text", default: "Second baseline" },
		]);
		let holding = false;
		const held: (() => void)[] = [];
		const route = async (page: Page) => {
			await page.routeWebSocket(/\/_webcraft\/edit\/drafts\/entry\//, (socket) => {
				const server = socket.connectToServer();
				server.onMessage((message) => {
					if (holding) held.push(() => socket.send(message));
					else socket.send(message);
				});
			});
		};
		const first = await enter(site, theme, false, false, route);
		const second = await enter(site, theme, true, false, route);
		try {
			await field(first, "First").fill("First person's input");
			await field(second, "Second").fill("Second person's input");
			holding = true;
			await Promise.all([field(first, "First").press("Tab"), field(second, "Second").press("Tab")]);
			await savedValues(site, { first: "First person's input", second: "Second person's input" });
			holding = false;
			for (const send of held.splice(0)) send();
			await valueIs(first, "Second", "Second person's input");
			await valueIs(second, "First", "First person's input");
		} finally {
			holding = false;
			for (const send of held.splice(0)) send();
			await first.close();
			await second.close();
		}
	});
	test(`pending Repeater input retains peer rows and their values (${theme})`, async () => {
		const site = await fixture(
			[{ key: "rows", label: "Rows", type: "repeater", fields: [{ key: "text", label: "Text", type: "text" }] }],
			{
				rows: {
					rows: [
						{ id: "north", values: { text: { en: "North" } } },
						{ id: "south", values: { text: { en: "South" } } },
					],
				},
			},
		);
		const first = await enter(site, theme);
		const second = await enter(site, theme, true);
		try {
			await field(first, "Text").nth(0).fill("Own North");
			await field(second, "Text").nth(1).fill("Peer South");
			await field(second, "Text").nth(1).press("Tab");
			await second.getByRole("button", { name: "Add to Rows", exact: true }).click();
			await field(second, "Text").nth(2).fill("Peer East");
			await field(second, "Text").nth(2).press("Tab");
			await first.getByRole("button", { name: /Peer East/ }).waitFor();
			expect(await field(first, "Text").nth(1).inputValue()).toBe("Peer South");
			expect(await field(first, "Text").nth(0).inputValue()).toBe("Own North");
			await field(first, "Text").nth(0).press("Tab");
			await second.getByRole("button", { name: /Own North/ }).waitFor();
			const result = (await site.read()).placements[0]?.values.rows as { id: string; text: string }[];
			expect(result.map((row) => row.text)).toEqual(["Own North", "Peer South", "Peer East"]);
			expect(result.slice(0, 2).map((row) => row.id)).toEqual(["north", "south"]);
		} finally {
			await first.close();
			await second.close();
		}
	});
}

for (const theme of THEMES) {
	test(`phone Props own Media and rich-text subdialogs (${theme})`, async () => {
		const site = await fixture([
			{ key: "image", label: "Image", type: "media" },
			{ key: "intro", label: "Intro", type: "richText" },
		]);
		const { media } = await site.staff.api.media.upload({
			siteId: site.input.siteId,
			file: upload(await photo({ width: 640, height: 480 }), "cork.jpg"),
		});
		await install.install.drainJobs();
		const page = await enter(site, theme, false, true);
		try {
			const sheet = page.getByRole("dialog", { name: "Props", exact: true });
			const choose = sheet.getByRole("button", { name: /Choose.*Image/ });
			await choose.tap();
			const chooser = page.getByRole("dialog", { name: "Choose a file", exact: true });
			await chooser.waitFor();
			await chooser.getByRole("button", { name: "cork.jpg", exact: true }).waitFor();
			expect(await chooser.evaluate((el) => !!el.closest("dialog[open]"))).toBe(true);
			await chooser.getByRole("searchbox").fill("cork");
			for (let i = 0; i < 8; i++) {
				await page.keyboard.press("Tab");
				await page.evaluate(
					() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
				);
				expect(
					await chooser.evaluate((el) => {
						let active = document.activeElement;
						while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
						return el.contains(active) ? "inside" : active?.outerHTML;
					}),
				).toBe("inside");
			}
			await expectNoAxeViolations(page, `phone Media chooser ${theme}`);
			await chooser.getByRole("button", { name: "cork.jpg", exact: true }).tap();
			await chooser.waitFor({ state: "hidden" });
			await sheet.getByRole("button", { name: /Change.*Image/ }).waitFor();
			expect(
				await sheet
					.getByRole("button", { name: /Change.*Image/ })
					.evaluate((el) => (el.getRootNode() as ShadowRoot).activeElement === el),
			).toBe(true);
			await savedValues(site, { image: media.id, intro: null });
			await sheet.getByRole("button", { name: "Add a link", exact: true }).tap();
			const link = page.getByRole("dialog", { name: "Add a link", exact: true });
			await link.getByLabel("Address", { exact: true }).fill("https://example.com/");
			await expectNoAxeViolations(page, `phone rich-text link ${theme}`);
			await page.keyboard.press("Escape");
			await link.waitFor({ state: "hidden" });
			expect(await sheet.isVisible()).toBe(true);
			expect(
				await sheet
					.getByRole("button", { name: "Add a link", exact: true })
					.evaluate((el) => (el.getRootNode() as ShadowRoot).activeElement === el),
			).toBe(true);
			await page.keyboard.press("Escape");
			await sheet.waitFor({ state: "hidden" });
			expect(
				await page
					.getByRole("button", { name: "Page layout", exact: true })
					.first()
					.evaluate((el) => {
						let active = document.activeElement;
						while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
						return active === el;
					}),
			).toBe(true);
		} finally {
			await page.close();
		}
	});
}

for (const theme of THEMES) {
	test(`pending Props refuse a deleted Placement without resurrecting it (${theme})`, async () => {
		const site = await fixture([{ key: "first", label: "First", type: "text", default: "Baseline" }]);
		const first = await enter(site, theme);
		const second = await enter(site, theme, true);
		try {
			await field(first, "First").fill("Orphaned input");
			await second.getByRole("button", { name: "Remove", exact: true }).click();
			await first.getByText("Select a Placement to edit its Props.").waitFor();
			await first.getByRole("button", { name: "Close", exact: true }).click();
			await first
				.locator("[data-editor-messages]")
				.filter({ hasText: /Someone/ })
				.waitFor();
			expect((await site.read()).layout.placements).toEqual([]);
		} finally {
			await first.close();
			await second.close();
		}
	});
	test(`pending Props survive a peer Placement move (${theme})`, async () => {
		const site = await fixture([{ key: "first", label: "First", type: "text", default: "Baseline" }]);
		await site.change((layout) => {
			const p = layout.placements[0];
			if (p) layout.placements.push({ ...p, id: "other" });
		});
		const first = await enter(site, theme);
		const second = await enter(site, theme, true);
		try {
			await first.getByRole("button", { name: "Page layout", exact: true }).click();
			await first.getByRole("treeitem").nth(2).click();
			await first.getByRole("button", { name: "Props", exact: true }).click();
			await field(first, "First").fill("Own moved input");
			expect(await field(first, "First").evaluate((el) => (el.getRootNode() as ShadowRoot).activeElement === el)).toBe(
				true,
			);
			expect((await site.read()).placements.find((p) => p.id === "other")?.values.first).toBe("Baseline");
			const moved = second.waitForResponse((response) => response.url().endsWith("/layout/save"));
			await second.getByRole("button", { name: "Move down", exact: true }).click();
			expect((await moved).ok()).toBe(true);
			await first.waitForFunction(
				() =>
					document.querySelector("main [data-wc-page-placement]")?.getAttribute("data-wc-page-placement") === "other",
			);
			expect(await field(first, "First").inputValue()).toBe("Own moved input");
			await field(first, "First").press("Tab");
			await second.getByRole("button", { name: "Page layout", exact: true }).click();
			await second.getByRole("treeitem").nth(1).click();
			await second.getByRole("button", { name: "Props", exact: true }).click();
			await valueIs(second, "First", "Own moved input");
			const result = await site.read();
			expect(result.placements.map((p) => p.id)).toEqual(["other", "hero"]);
			expect(result.placements.map((p) => p.values.first)).toEqual(["Own moved input", "Baseline"]);
		} finally {
			await first.close();
			await second.close();
		}
	});
	test(`pending same-text Props merge disjoint typing (${theme})`, async () => {
		const site = await fixture([{ key: "first", label: "First", type: "text", default: "Middle" }]);
		const first = await enter(site, theme);
		const second = await enter(site, theme, true);
		try {
			await field(first, "First").fill("Start Middle");
			await field(second, "First").fill("Middle End");
			await field(second, "First").press("Tab");
			await valueIs(first, "First", "Start Middle End");
			await field(first, "First").press("Tab");
			await savedValues(site, { first: "Start Middle End" });
		} finally {
			await first.close();
			await second.close();
		}
	});
}

for (const theme of THEMES) {
	test(`pending inline text retains peer text typed in Props (${theme})`, async () => {
		const site = await fixture([{ key: "first", label: "First", type: "text", default: "Middle" }]);
		await site.staff.api.components.saveMarkup({
			siteId: site.input.siteId,
			componentId: site.component.id,
			markup: "<h1>{{ props.first }}</h1>",
		});
		await site.staff.api.components.publish({ siteId: site.input.siteId, componentId: site.component.id });
		const first = await enter(site, theme);
		const second = await enter(site, theme, true);
		try {
			await first.getByRole("button", { name: "Close", exact: true }).click();
			const inline = first.locator("main [data-wc-placement-prop]");
			await inline.fill("Start Middle");
			await field(second, "First").fill("Middle End");
			await field(second, "First").press("Tab");
			await savedValues(site, { first: "Middle End" });
			await valueIs(first, "First", "Middle End");
			await inline.press("Enter");
			await savedValues(site, { first: "Start Middle End" });
			await second.locator("h1").filter({ hasText: "Start Middle End" }).waitFor();
		} finally {
			await first.close();
			await second.close();
		}
	});
	test(`pending Repeater input refuses a peer-deleted row (${theme})`, async () => {
		const site = await fixture(
			[{ key: "rows", label: "Rows", type: "repeater", fields: [{ key: "text", label: "Text", type: "text" }] }],
			{
				rows: {
					rows: [
						{ id: "north", values: { text: { en: "North" } } },
						{ id: "south", values: { text: { en: "South" } } },
					],
				},
			},
		);
		const first = await enter(site, theme);
		const second = await enter(site, theme, true);
		try {
			await field(first, "Text").first().fill("Removed input");
			await second.getByRole("button", { name: "Actions for row 1", exact: true }).click();
			await second.getByRole("menuitem", { name: "Remove row", exact: true }).click();
			await first.waitForFunction(
				() =>
					document
						.querySelector("#webcraft-page-layout")
						?.shadowRoot?.querySelectorAll('[data-editor-region="inspector"] input').length === 1,
			);
			await first.getByRole("button", { name: "Close", exact: true }).click();
			await first
				.locator("[data-editor-messages]")
				.filter({ hasText: /Someone/ })
				.waitFor();
			await savedValues(site, { rows: [{ id: "south", text: "South" }] });
		} finally {
			await first.close();
			await second.close();
		}
	});
	test(`pending Props refuse a replaced declaration with the same key (${theme})`, async () => {
		const site = await fixture([{ key: "first", label: "First", type: "text", default: "Baseline" }]);
		const first = await enter(site, theme);
		try {
			await field(first, "First").fill("Old declaration input");
			const newId = crypto.randomUUID();
			await site.staff.api.components.saveMarkup({
				siteId: site.input.siteId,
				componentId: site.component.id,
				markup: `{{@props}}\nfirst: text id="${newId}" default="Replacement"\n{{/props}}\n<h1>{{ props.first }}</h1>`,
			});
			await site.staff.api.components.publish({ siteId: site.input.siteId, componentId: site.component.id });
			await first.locator("h1").filter({ hasText: "Replacement" }).waitFor();
			await first.getByRole("button", { name: "Close", exact: true }).click();
			await first
				.locator("[data-editor-messages]")
				.filter({ hasText: /Someone/ })
				.waitFor();
			const result = await site.read();
			expect(result.placements[0]?.props[0]?.id).toBe(newId);
			expect(result.placements[0]?.values.first).toBe("Replacement");
		} finally {
			await first.close();
		}
	});
}

for (const theme of THEMES) {
	test(`empty Page Props accept successive keystrokes before blur (${theme})`, async () => {
		const site = await fixture([
			{ key: "first", label: "First", type: "text" },
			{ key: "group", label: "Group", type: "group", fields: [{ key: "second", label: "Second", type: "text" }] },
		]);
		const page = await enter(site, theme);
		try {
			await field(page, "First").focus();
			await page.keyboard.type("ab");
			await field(page, "First").press("Tab");
			await field(page, "Second").focus();
			await page.keyboard.type("cd");
			await field(page, "Second").press("Tab");
			await savedValues(site, { first: "ab", group: { second: "cd" } });
		} finally {
			await page.close();
		}
	});
}

for (const theme of THEMES) {
	test(`a refused Page Prop exposes the saved value and accepts its next correction (${theme})`, async () => {
		const site = await fixture([
			{ key: "link", label: "Link", type: "link", default: { url: "https://example.com/old", text: "Old" } },
		]);
		const page = await enter(site, theme);
		try {
			await field(page, "Address").fill("javascript:alert(1)");
			// Clicking away keeps the idle Inspector mounted; focusing another Link input would
			// flush and replace that input owner, hiding a stale-document regression.
			await page.getByRole("heading", { name: "Props", exact: true }).click();
			await page
				.locator("[data-editor-messages]")
				.filter({ hasText: /Someone/ })
				.waitFor();
			await valueIs(page, "Address", "https://example.com/old");
			await savedValues(site, { link: { url: "https://example.com/old", text: "Old" } });
			await field(page, "Address").fill("https://example.com/new");
			await field(page, "Address").press("Tab");
			await savedValues(site, { link: { url: "https://example.com/new", text: "Old" } });
		} finally {
			await page.close();
		}
	});
}
