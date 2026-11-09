// A publish fires the Site's Webhooks (spec story 139): once it is saved, the worker sends each
// Webhook that receives `publish` a small signed JSON event, through the guarded fetcher. The publish
// never waits for a receiver and never fails because of one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RecordedRequest } from "../harness/fake-http.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { element, tree, value } from "../harness/trees.ts";
import { receiverAccepts } from "./support.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let staffId: string;

/** The receiver's public address, as DNS answers it. */
const RECEIVER_ADDRESS = "93.184.216.34";

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	const created = await install.createStaff({ workspaces: [workspaceId], name: "Ada Staff" });
	staff = created.browser;
	staffId = created.personId;
	install.dns.answer("hooks.agency.example", [RECEIVER_ADDRESS]);
});

afterAll(async () => {
	await install.close();
});

/** A Site with a Post Type whose Entries are at `/posts/<slug>`, and an Entry ready to publish. */
async function siteWithEntry(slug: string): Promise<{ siteId: string; postTypeId: string; entryId: string }> {
	const { id: siteId } = await install.createSite(workspaceId, { name: "Acme Bakery", slug });
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Posts", urlPattern: "/posts/{slug}" });
	const { template } = await staff.api.templates.saveEntryTemplate({
		siteId,
		postTypeId: postType.id,
		tree: tree(element("h1", [value("title")])),
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread daily" });
	return { siteId, postTypeId: postType.id, entryId: entry.id };
}

/** The requests made to a URL so far. */
function requestsTo(url: string): RecordedRequest[] {
	return install.http.requests.filter((request) => request.url === url);
}

describe("publishing an Entry", () => {
	test("sends each Webhook that receives `publish` a signed event from the worker, once it is saved", async () => {
		const { siteId, postTypeId, entryId } = await siteWithEntry("signed-bakery");
		const url = "https://hooks.agency.example/webcraft";
		install.http.respond("POST", url, { status: 204 });
		const { webhook, secret } = await staff.api.webhooks.add({ siteId, url, events: ["publish"] });

		await staff.api.entries.publish({ siteId, entryId });
		expect(requestsTo(url)).toEqual([]);

		expect((await install.drainJobs()).failed).toEqual([]);
		const [request, ...more] = requestsTo(url);
		expect(more).toEqual([]);
		if (!request || !secret) throw new Error("No delivery was sent.");

		expect(request.method).toBe("POST");
		expect(request.address).toBe(RECEIVER_ADDRESS);
		expect(request.headers.get("content-type")).toBe("application/json");
		expect(request.headers.get("webcraft-event")).toBe("publish");
		expect(receiverAccepts(request, secret, install.clock.now())).toBe(true);
		expect(receiverAccepts(request, "another-secret-of-the-same-length-43chars!!", install.clock.now())).toBe(false);

		const delivery = request.headers.get("webcraft-delivery");
		expect(JSON.parse(request.body)).toEqual({
			id: delivery,
			type: "publish",
			occurredAt: install.clock.now().toISOString(),
			site: { id: siteId, name: "Acme Bakery", url: "https://signed-bakery.sites.test" },
			data: {
				item: { kind: "entry", id: entryId, postTypeId, path: "/posts/fresh-bread-daily" },
				pathChanges: [],
				by: { id: staffId, name: "Ada Staff" },
				via: "admin",
			},
		});
		// Content values stay on the Site: the title isn't sent.
		expect(request.body).not.toContain("Fresh bread daily");
		expect(request.body).not.toContain(secret);
		expect(webhook.status).toBe("on");
	});

	test("a receiver that is down neither fails nor holds up the publish", async () => {
		const { siteId, entryId } = await siteWithEntry("unanswered-bakery");
		await staff.api.webhooks.add({ siteId, url: "https://hooks.agency.example/nobody-answers", events: ["publish"] });

		const { entry } = await staff.api.entries.publish({ siteId, entryId });

		expect(entry.status).toBe("published");
		expect((await install.drainJobs()).failed).toEqual([]);
		expect(requestsTo("https://hooks.agency.example/nobody-answers")).toHaveLength(1);
	});

	test("a publish that is refused sends nothing", async () => {
		const { siteId } = await siteWithEntry("refused-bakery");
		const url = "https://hooks.agency.example/refused";
		install.http.respond("POST", url, { status: 200 });
		await staff.api.webhooks.add({ siteId, url, events: ["publish"] });
		const { postType } = await staff.api.postTypes.create({
			siteId,
			name: "Products",
			urlPattern: "/products/{slug}",
			fields: [{ key: "price", label: "Price", type: "number", required: true }],
		});
		const { entry } = await staff.api.entries.create({ siteId, postTypeId: postType.id, title: "Unpriced loaf" });

		await expect(staff.api.entries.publish({ siteId, entryId: entry.id })).rejects.toMatchObject({
			code: "ENTRY_INCOMPLETE",
		});
		await install.drainJobs();

		expect(requestsTo(url)).toEqual([]);
	});
});

describe("publishing other items", () => {
	test("the Globals, Templates and the Design system fire `publish` too, naming what was published", async () => {
		const { siteId, postTypeId } = await siteWithEntry("structure-bakery");
		const url = "https://hooks.agency.example/structure";
		install.http.respond("POST", url, { status: 200 });
		await staff.api.webhooks.add({ siteId, url, events: ["publish"] });

		await staff.api.globals.publish({ siteId });
		const { template } = await staff.api.templates.getEntryTemplate({ siteId, postTypeId });
		await staff.api.templates.publish({ siteId, templateId: template?.id ?? "" });
		await staff.api.designSystem.publish({ siteId });
		await install.drainJobs();

		// Jobs queued in the same instant go out in any order.
		const items = requestsTo(url)
			.map((request) => JSON.parse(request.body).data.item)
			.sort((a, b) => a.kind.localeCompare(b.kind));
		expect(items).toEqual([
			{ kind: "designSystem", id: expect.any(String) },
			{ kind: "globals", id: expect.any(String) },
			{ kind: "template", id: template?.id, postTypeId },
		]);
	});
});
