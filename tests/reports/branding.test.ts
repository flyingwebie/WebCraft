// Branding of Reports and Share links (#104, spec story 133): the agency brand the Superadmin sets for
// the Install, which a Workspace may replace with its own; the client brand (the Site's name and logo,
// else the Workspace's); and "Made with WebCraft", each switched on or off. Apart from Install branding,
// which is for System emails. And the Services list, which Staff write once for the Install.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { photo } from "../harness/images.ts";
import { createTestInstall, fromAddress, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { attachedReport, mailTo, reportedSite } from "./support.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let superadmin: TestBrowser;
let png: string;

beforeAll(async () => {
	install = await createTestInstall({ now: new Date("2026-03-04T09:00:00Z") });
	superadmin = await install.superadmin();
	await superadmin.api.modules.approve({ moduleId: "site-analytics", version: "1.1.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	png = Buffer.from(await photo({ width: 40, height: 20, format: "png" })).toString("base64");
});

afterAll(async () => {
	await install.close();
});

let sites = 0;
const newSite = () => reportedSite(install, staff, workspaceId, `bakery-brand-${++sites}.example`);

/** A Share link's page, as anyone holding it sees it. */
async function sharePage(site: { siteId: string; dashboardId: string }): Promise<string> {
	const { url } = await staff.api.shareLinks.create({
		siteId: site.siteId,
		dashboardId: site.dashboardId,
		name: "Look",
	});
	return (await install.request(fromAddress(new Request(url), "198.51.100.9"))).text();
}

describe("the brand on Reports and Share links", () => {
	test("shows the Install's agency brand, the Site as the client and Made with WebCraft, until switched off", async () => {
		const { branding } = await superadmin.api.reportBranding.install.update({
			name: "Harbour Digital",
			accentColour: "#0F766E",
			logo: { contentType: "image/png", data: png },
		});
		expect(branding).toMatchObject({
			name: "Harbour Digital",
			accentColour: "#0f766e",
			logo: { contentType: "image/png" },
			showAgency: true,
			showClient: true,
			madeWith: true,
		});
		const site = await newSite();

		const html = await sharePage(site);
		expect(html).toContain(`<img src="data:image/png;base64,${png}" alt="Harbour Digital">`);
		expect(html).toContain('<span class="brand-name">Harbour Digital</span>');
		expect(html).toContain('fill="#0f766e"');
		expect(html).toContain('<span class="brand-name">Bakery</span>');
		expect(html).toContain("Made with WebCraft");

		await superadmin.api.reportBranding.install.update({ showAgency: false, madeWith: false });
		const plain = await sharePage(site);
		expect(plain).not.toContain("Harbour Digital");
		expect(plain).not.toContain("Made with WebCraft");
		expect(plain).toContain('<span class="brand-name">Bakery</span>');
		await superadmin.api.reportBranding.install.update({ showAgency: true, madeWith: true });

		// System emails' Install branding is another thing, and stays as it was.
		expect((await superadmin.api.install.emailBranding.get()).senderName).toBeNull();
	});

	test("a Workspace replaces the agency brand with its own, chooses what shows, and its Sites name their client brand", async () => {
		const site = await newSite();
		await staff.api.reportBranding.workspace.update({
			workspaceId,
			ownAgency: true,
			agency: { name: "Acme's own studio", accentColour: "#1d4ed8" },
			client: { name: "Acme <Group>", logo: { contentType: "image/png", data: png } },
			madeWith: false,
		});
		await staff.api.reportBranding.site.update({ siteId: site.siteId, client: { name: "Bakery & Café" } });

		const html = await sharePage(site);
		expect(html).toContain(`<span class="brand-name">Acme's own studio</span>`);
		expect(html).not.toContain("Harbour Digital");
		expect(html).toContain('fill="#1d4ed8"');
		// The Site's own name, escaped, with the Workspace's logo while the Site has none.
		expect(html).toContain(`<img src="data:image/png;base64,${png}" alt="Bakery &amp; Café">`);
		expect(html).not.toContain("Made with WebCraft");

		// The same brand is on its Reports.
		const { report } = await staff.api.reports.create({
			siteId: site.siteId,
			dashboardId: site.dashboardId,
			name: "Weekly",
			schedule: "weekly",
			language: "en",
			recipients: ["brand@bakery.example"],
			review: false,
			active: true,
		});
		await staff.api.reports.sendTest({ siteId: site.siteId, reportId: report.id });
		await install.drainJobs();
		const pdf = attachedReport(mailTo(install, (await staff.api.session.current()).person?.email ?? "")[0]);
		expect(pdf.text).toContain("Bakery & Café Acme's own studio");
		expect(pdf.text).not.toContain("Made with WebCraft");

		// A Workspace Dashboard's client is the Workspace.
		const { dashboard } = await staff.api.dashboards.create({ workspaceId, name: "All" });
		const { url } = await staff.api.shareLinks.create({ workspaceId, dashboardId: dashboard.id, name: "All" });
		const workspacePage = await (await install.request(fromAddress(new Request(url), "198.51.100.9"))).text();
		expect(workspacePage).toContain(`alt="Acme &lt;Group&gt;"`);

		expect(await staff.api.reportBranding.workspace.get({ workspaceId })).toMatchObject({
			branding: {
				ownAgency: true,
				agency: { name: "Acme's own studio", accentColour: "#1d4ed8", logo: null },
				client: { name: "Acme <Group>", logo: { contentType: "image/png" } },
				showAgency: null,
				madeWith: false,
				install: { showAgency: true, showClient: true, madeWith: true },
			},
		});
	});

	test("takes only PNG, JPEG and WebP logos of at most 256 KB, checked by their bytes, and colours written #rrggbb", async () => {
		const gif = Buffer.from(await photo({ width: 4, height: 4, format: "gif" })).toString("base64");
		await expect(
			staff.api.reportBranding.workspace.update({
				workspaceId,
				client: { logo: { contentType: "image/gif", data: gif } },
			}),
		).rejects.toMatchObject({ code: "BRANDING_INVALID", data: { field: "logo" } });
		await expect(
			staff.api.reportBranding.workspace.update({
				workspaceId,
				client: { logo: { contentType: "image/png", data: gif } },
			}),
		).rejects.toMatchObject({ code: "BRANDING_INVALID", data: { field: "logo" } });
		const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString(
			"base64",
		);
		await expect(
			staff.api.reportBranding.workspace.update({
				workspaceId,
				client: { logo: { contentType: "image/svg+xml", data: svg } },
			}),
		).rejects.toMatchObject({ code: "BRANDING_INVALID", data: { field: "logo" } });
		const large = Buffer.concat([
			Buffer.from(await photo({ width: 4, height: 4, format: "png" })),
			Buffer.alloc(262_000),
		]);
		await expect(
			staff.api.reportBranding.workspace.update({
				workspaceId,
				client: { logo: { contentType: "image/png", data: large.toString("base64") } },
			}),
		).rejects.toMatchObject({ code: "BRANDING_INVALID", data: { field: "logo" } });
		await expect(
			staff.api.reportBranding.workspace.update({ workspaceId, agency: { accentColour: "orange" } }),
		).rejects.toMatchObject({ code: "BRANDING_INVALID", data: { field: "accentColour" } });
	});

	test("Staff brand Workspaces and Sites; only the Superadmin brands the Install; Owners do neither", async () => {
		const site = await newSite();
		const owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
		await expect(staff.api.reportBranding.install.update({ name: "Mine" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(owner.api.reportBranding.workspace.update({ workspaceId, madeWith: true })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(owner.api.reportBranding.site.get({ siteId: site.siteId })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		const { entries } = await superadmin.api.audit.list({ limit: 50 });
		expect(
			entries.filter((entry) => entry.action === "reportBranding.change").map((entry) => entry.details),
		).toContainEqual({
			level: "site",
			changed: ["client.name"],
		});
	});
});

describe("the Services list", () => {
	test("is written by Staff once for the Install, read by the Superadmin too, and never by Owners", async () => {
		const owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
		const { services } = await staff.api.servicesList.update({
			services: [{ name: "  Search engine optimisation ", description: "Getting found." }, { name: "Newsletters" }],
		});
		expect(services).toMatchObject([
			{ name: "Search engine optimisation", description: "Getting found." },
			{ name: "Newsletters", description: "" },
		]);
		// An id kept keeps the service; one it doesn't know becomes a new one.
		const kept = await staff.api.servicesList.update({
			services: [
				{ id: services[1]?.id, name: "Email newsletters" },
				{ id: "made-up", name: "Hosting" },
			],
		});
		expect(kept.services[0]?.id).toBe(services[1]?.id);
		expect(kept.services[1]?.id).not.toBe("made-up");
		expect((await superadmin.api.servicesList.get()).services.map((service) => service.name)).toEqual([
			"Email newsletters",
			"Hosting",
		]);
		await expect(owner.api.servicesList.get()).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(staff.api.servicesList.update({ services: [{ name: " " }] })).rejects.toMatchObject({
			code: "SERVICES_LIST_INVALID",
		});
		// Staff hold nothing else on the Install: not the whole Install's Audit log.
		await expect(staff.api.audit.list({ limit: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
