import { afterEach, beforeEach, expect, test } from "bun:test";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
beforeEach(async () => {
	install = await startBrowserInstall();
});
afterEach(async () => {
	await install.close();
});

for (const { input, canvas } of [
	{ input: "Inspector", canvas: "live" },
	{ input: "HTML", canvas: "live" },
	{ input: "Inspector", canvas: "preview" },
] as const) {
	for (const theme of THEMES) {
		test(`one-off styles preserve a peer edit through ${input} on the ${canvas} canvas (${theme})`, async () => {
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
