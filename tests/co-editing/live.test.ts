import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { openDraft } from "../harness/co-editing.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { coEditingSite, valueIn, withValue } from "./support.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});

describe("two editors on one Draft", () => {
	test("each sees the Draft as it is, and the other's changes to other values as they are saved", async () => {
		const site = await coEditingSite(install);
		const item = { kind: "entry", id: site.entryId } as const;
		const ada = await openDraft(install, site.staff, site.siteId, item);
		const eve = await openDraft(install, site.editor, site.siteId, item);
		expect(valueIn(ada.draft(), "title")).toBe("Fresh bread");
		expect(valueIn(eve.draft(), "summary")).toBe("Bake it today.");

		// Both change the Draft before either sees the other's change.
		ada.change((draft) => withValue(draft, "title", "Fresh rye bread"));
		eve.change((draft) => withValue(draft, "summary", "Bake it this morning."));
		await ada.saved();
		await eve.saved();
		await ada.untilDraft((draft) => valueIn(draft, "summary") === "Bake it this morning.", "Eve's summary at Ada's");
		await eve.untilDraft((draft) => valueIn(draft, "title") === "Fresh rye bread", "Ada's title at Eve's");

		// The Draft everyone else reads (the API, the Staging address) has both.
		const { entry } = await site.editor.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.draft.title).toBe("Fresh rye bread");
		expect(entry.draft.fields.summary).toBe("Bake it this morning.");
		ada.close();
		eve.close();
	});
});
