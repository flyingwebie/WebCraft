import { afterEach, beforeEach, expect, test } from "bun:test";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
beforeEach(async () => {
	install = await startBrowserInstall();
});
afterEach(async () => {
	await install.close();
});

async function editorPage(theme: (typeof THEMES)[number], canvas: "live" | "preview") {
	const local = install.install;
	const { api } = await local.superadmin();
	const workspace = await local.createWorkspace("Style co-editing");
	const { id: siteId } = await local.createSite(workspace.id, {
		name: "Style co-editing",
		slug: "style-co-editing",
	});
	const staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
	const original =
		'<header data-wc-id="header"><p data-wc-id="greeting" data-wc-label="Before">Original text</p></header><main>{{@outlet}}</main>';
	await api.templates.saveSiteTemplateMarkup({ siteId, markup: original });
	const page = await install.newPage(theme);
	page.setDefaultTimeout(10000);
	await install.signIn(page, staff);
	if (canvas === "preview") await page.goto(install.adminUrl(`/builder/${siteId}/site-template`));
	else {
		await page.goto(install.adminUrl(`/sites/${siteId}`));
		await page.getByRole("button", { name: "Edit on site" }).click();
		await page.waitForURL((url) => url.hostname.startsWith("style-co-editing"));
		await page.getByRole("button", { name: "Code", exact: true }).click();
	}
	const tree = page.getByRole("tree", { name: "Layers" });
	return { api, siteId, original, page, tree };
}

for (const theme of THEMES) {
	test(`an old Inspector refresh preserves the peer's tree for the next edit (${theme})`, async () => {
		const { api, siteId, page, tree } = await editorPage(theme, "live");
		const release = Promise.withResolvers<void>();
		try {
			await tree.getByRole("treeitem", { name: /^Before/ }).click();
			await page.getByLabel("Layer label", { exact: true }).waitFor();
			await page.getByRole("tab", { name: "Style", exact: true }).click();
			await page.getByLabel("Declarations", { exact: true }).fill("color: rgb(1, 2, 3);");
			await page.waitForLoadState("networkidle");
			let afterSave = false;
			let capture = true;
			const held = Promise.withResolvers<void>();
			page.on("response", (response) => {
				if (response.url().endsWith("/code/save") && response.status() === 200) afterSave = true;
			});
			await page.route("**/_webcraft/edit/api/code/editor", async (route) => {
				if (!afterSave || !capture) return route.continue();
				const response = await route.fetch();
				held.resolve();
				await release.promise;
				await route.fulfill({ response });
			});
			await page.getByRole("button", { name: "Apply", exact: true }).click();
			await held.promise;
			// Let the post-save refreshes start, holding their real responses before the peer edit.
			await page.waitForTimeout(500);
			capture = false;
			const styled = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
			await api.templates.saveSiteTemplateMarkup({
				siteId,
				markup: styled.replace('data-wc-label="Before"', 'data-wc-label="Remote"'),
			});
			await tree.getByRole("treeitem", { name: /^Remote/ }).waitFor();
			release.resolve();
			await page.waitForLoadState("networkidle");
			await page.getByRole("tab", { name: "Settings", exact: true }).click();
			await page.getByLabel("Tag", { exact: true }).fill("h2");
			await page.getByLabel("Tag", { exact: true }).press("Enter");
			let saved = "";
			for (let attempt = 0; attempt < 100; attempt++) {
				saved = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
				if (saved.includes("<h2 ")) break;
				await page.waitForTimeout(50);
			}
			expect(saved).toContain("<h2 ");
			expect(saved).toContain('data-wc-label="Remote"');
		} finally {
			release.resolve();
		}
	});

	test(`a late remote paint cannot replace newly saved HTML (${theme})`, async () => {
		const { api, siteId, original, page, tree } = await editorPage(theme, "live");
		const release = Promise.withResolvers<void>();
		try {
			await tree.getByRole("treeitem", { name: /^Before/ }).waitFor();
			await page.waitForLoadState("networkidle");
			const html = page.getByRole("textbox", { name: /^HTML of / });
			const shown = await html.inputValue();
			await html.fill(`${shown}<aside`);
			await page.waitForTimeout(500);
			const printing = Promise.withResolvers<void>();
			const fulfilled = Promise.withResolvers<void>();
			let hold = true;
			await page.route("**/_webcraft/edit/api/code/editorMarkup", async (route) => {
				const input = route.request().postDataJSON();
				if (!hold || !JSON.stringify(input.draft?.tree).includes('"label":"Remote"')) return route.continue();
				hold = false;
				const response = await route.fetch();
				printing.resolve();
				await release.promise;
				await route.fulfill({ response });
				fulfilled.resolve();
			});
			await api.templates.saveSiteTemplateMarkup({
				siteId,
				markup: original.replace('data-wc-label="Before"', 'data-wc-label="Remote"'),
			});
			await printing.promise;
			await tree.getByRole("treeitem", { name: /^Remote/ }).waitFor();
			await html.fill(shown.replace("Original text", "Newly saved text"));
			await page.waitForFunction(() =>
				document
					.querySelector("webcraft-code-mode")
					?.shadowRoot?.querySelector("textarea")
					?.value.includes('data-wc-label="Remote"'),
			);
			expect(await html.inputValue()).toContain("Newly saved text");
			release.resolve();
			await fulfilled.promise;
			await page.waitForLoadState("networkidle");
			await html.fill((await html.inputValue()).replace("<header ", '<header data-wc-label="Local header" '));
			let saved = "";
			for (let attempt = 0; attempt < 100; attempt++) {
				saved = (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
				if (saved.includes('data-wc-label="Local header"')) break;
				await page.waitForTimeout(50);
			}
			expect(saved).toContain('data-wc-label="Local header"');
			expect(saved).toContain("Newly saved text");
			expect(saved).toContain('data-wc-label="Remote"');
		} finally {
			release.resolve();
		}
	});
}

for (const { input, canvas } of [
	{ input: "Inspector", canvas: "live" },
	{ input: "HTML", canvas: "live" },
	{ input: "Inspector", canvas: "preview" },
] as const) {
	for (const theme of THEMES) {
		test(`one-off styles preserve a peer edit through ${input} on the ${canvas} canvas (${theme})`, async () => {
			const { api, siteId, original, page, tree } = await editorPage(theme, canvas);
			if (input === "Inspector") {
				const selected =
					canvas === "live"
						? page.waitForResponse((response) => response.url().endsWith("/code/open"))
						: Promise.resolve();
				await tree.getByRole("treeitem", { name: /^Before/ }).click();
				await selected;
				await page.getByLabel("Layer label", { exact: true }).waitFor();
				await page.getByRole("tab", { name: "Style", exact: true }).click();
				await page.getByLabel("Declarations", { exact: true }).fill("color: rgb(1, 2, 3);");
			}
			await tree.getByRole("treeitem", { name: /^Before/ }).waitFor();
			await page.waitForLoadState("networkidle");

			// Hold a real read for Inspector styles, or a printed HTML response, while the peer saves.
			const sourceReads =
				canvas === "preview"
					? /\/api\/rpc\/builder\/open$/
					: input === "Inspector"
						? /\/_webcraft\/edit\/api\/code\/(open|editor)$/
						: /\/_webcraft\/edit\/api\/code\/editorMarkup$/;
			const reading = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			await page.route(sourceReads, async (route) => {
				if (input === "HTML") {
					if (!Object.keys(route.request().postDataJSON().draft?.styles ?? {}).length) return route.continue();
					const response = await route.fetch();
					reading.resolve();
					await release.promise;
					await route.fulfill({ response });
				} else {
					reading.resolve();
					await release.promise;
					await route.continue();
				}
			});
			try {
				const saving = page.waitForResponse((response) =>
					response.url().endsWith(canvas === "live" ? "/code/save" : "/templates/saveSiteTemplateMarkup"),
				);
				if (input === "Inspector") await page.getByRole("button", { name: "Apply", exact: true }).click();
				else {
					const html = page.getByRole("textbox", { name: /^HTML of / });
					expect(await html.inputValue()).toContain("Original text");
					await html.fill((await html.inputValue()).replace("<p ", '<p style="color: rgb(1, 2, 3);" '));
				}
				await reading.promise;
				await api.templates.saveSiteTemplateMarkup({
					siteId,
					markup: original.replace('data-wc-label="Before"', 'data-wc-label="Remote"'),
				});
				await tree.getByRole("treeitem", { name: /^Remote/ }).waitFor();
				release.resolve();
				expect((await saving).status()).toBe(input === "HTML" ? 409 : 200);
				expect((await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft).toContain(
					'data-wc-label="Remote"',
				);
				if (input === "Inspector")
					for (const applied of [true, false]) {
						if (!applied) {
							await page.waitForLoadState("networkidle");
							await page.getByLabel("Declarations", { exact: true }).fill("");
							await page.getByRole("button", { name: "Apply", exact: true }).click();
						}
						await page.waitForFunction(
							({ canvas, applied }) => {
								const frame = document.querySelector<HTMLIFrameElement>('iframe[title^="Canvas"]');
								const documentOf = canvas === "preview" ? frame?.contentDocument : document;
								const windowOf = canvas === "preview" ? frame?.contentWindow : window;
								const paragraph = documentOf?.querySelector("header p");
								return paragraph && (windowOf?.getComputedStyle(paragraph).color === "rgb(1, 2, 3)") === applied;
							},
							{ canvas, applied },
						);
					}
			} finally {
				release.resolve();
			}
		});
	}
}
