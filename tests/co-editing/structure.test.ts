// Structure co-edited live (ADR 0025): two Staff change the same Template's tree at once and both
// changes stay; a tree the Template's own save refuses is dropped for everyone. Members never open it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DocumentJson } from "@webcraft/core";

import { openDraft, upgradeDraft } from "../harness/co-editing.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { coEditingSite } from "./support.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});

type Node = { type: string; id?: string; text?: string; children?: Node[]; tag?: string };

/** The tree with the text inside the element `id` replaced. */
function withText(draft: DocumentJson, id: string, text: string): DocumentJson {
	const walk = (nodes: Node[]): Node[] =>
		nodes.map((node) =>
			node.id === id
				? { ...node, children: [{ type: "text", text }] }
				: node.children
					? { ...node, children: walk(node.children) }
					: node,
		);
	const tree = draft as { version: number; nodes: Node[] };
	return { ...tree, nodes: walk(tree.nodes) } as unknown as DocumentJson;
}

describe("a Template's Draft", () => {
	test("merges two Staff's changes to different elements, and refuses a tree its save refuses", async () => {
		const site = await coEditingSite(install);
		const other = await install.createStaff({ workspaces: [site.workspaceId], name: "Sol Staff" });
		const saved = await site.staff.api.templates.saveEntryTemplateMarkup({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			markup: '<article><h1 data-wc-id="heading">Recipe</h1><p data-wc-id="lead">Fresh today</p></article>',
		});
		const item = { kind: "template", id: saved.template.id } as const;
		const ada = await openDraft(install, site.staff, site.siteId, item);
		const sol = await openDraft(install, other.browser, site.siteId, item);

		ada.change((draft) => withText(draft, "heading", "Our recipe"));
		sol.change((draft) => withText(draft, "lead", "Baked this morning"));
		await ada.saved();
		await sol.saved();
		await ada.untilDraft((draft) => JSON.stringify(draft).includes("Baked this morning"), "Sol's change at Ada's");
		const { markup } = await site.staff.api.templates.getEntryTemplateMarkup({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
		});
		expect(markup?.draft).toContain("Our recipe");
		expect(markup?.draft).toContain("Baked this morning");

		// A script element is never allowed in a Template: the save refuses it, for everyone.
		sol.change((draft) => {
			const tree = draft as unknown as { version: number; nodes: Node[] };
			return {
				...tree,
				nodes: [
					...tree.nodes,
					{ type: "element", id: "sneaky", tag: "script", attributes: [], classes: [], children: [] },
				],
			} as unknown as DocumentJson;
		});
		await sol.until(() => sol.refusals.length === 1, "the refusal");
		expect(sol.refusals[0]?.code).toBe("TEMPLATE_INVALID");
		await sol.untilDraft(
			(draft) => !JSON.stringify(draft).includes("sneaky"),
			"Sol's copy back as the server holds it",
		);
		expect(JSON.stringify(ada.draft())).not.toContain("sneaky");

		// Structure is Staff's: an Editor of the Site can't open it.
		const refused = await upgradeDraft(install, site.editor, site.siteId, item);
		expect(refused instanceof Response && refused.status).toBe(403);
		ada.close();
		sol.close();
	});
});
