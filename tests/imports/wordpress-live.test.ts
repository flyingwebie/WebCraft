import { afterAll, beforeAll, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import type { FakeAnswer } from "../harness/fake-http.ts";
import { photo } from "../harness/images.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { exportedArchive, importArchive, manifestIn, PASSPHRASE, tarFiles } from "../harness/site-transfer.ts";
import { approveModules, OLD_SITE_ADDRESS } from "./wordpress.ts";

function required<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error("Expected the public response to contain this value.");
	return value;
}

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
	await approveModules(install);
	install.dns.answer("live.example", [OLD_SITE_ADDRESS]);
	install.http.respond("GET", /^https:\/\/live.example\//, (request) => {
		const url = new URL(request.url);
		expect(request.headers.get("authorization")).toBe(
			`Basic ${Buffer.from("writer:one-time-password").toString("base64")}`,
		);
		if (url.pathname.endsWith("/users/me")) return { body: JSON.stringify({ roles: ["editor"] }) };
		if (url.pathname.endsWith("/types"))
			return { body: JSON.stringify({ post: { name: "Posts", rest_base: "posts", rest_namespace: "wp/v2" } }) };
		if (url.pathname.endsWith("/taxonomies")) return { body: "{}" };
		expect(url.searchParams.get("status")).toBe("publish");
		return {
			body: JSON.stringify([
				{
					id: 7,
					type: "post",
					status: "publish",
					title: { rendered: "Hello" },
					content: { rendered: "<p>Welcome</p>" },
					slug: "hello",
					link: "https://live.example/hello",
				},
			]),
			headers: { "x-wp-total": "1", "x-wp-totalpages": "1" },
		};
	});
});
afterAll(async () => {
	await install.close();
});

test("Test connection shows roles and counts, defaults to published posts and never reads credentials back", async () => {
	const workspace = await install.createWorkspace();
	const site = await install.createSite(workspace.id);
	const { api } = (await install.createStaff({ workspaces: [workspace.id] })).browser;

	const connected = await api.imports.connect({
		siteId: site.id,
		source: "wordpress-import.live",
		name: "Live site",
		address: "https://live.example",
		username: "writer",
		applicationPassword: "one-time-password",
	});
	expect(connected.connection).toMatchObject({
		roles: ["editor"],
		types: [{ key: "post", count: 1 }],
		includeHidden: false,
	});
	expect(JSON.stringify(connected)).not.toContain("one-time-password");
	expect(JSON.stringify(connected)).not.toContain("writer");
	await install.drainJobs();
	const { file } = await api.imports.file({ siteId: site.id, fileId: connected.file.id });
	expect(file.status).toBe("ready");
	expect(file.survey?.items).toBe(1);
});

test("a live Import reuses the pipeline, reports REST limitations and matches Source ids on Run again", async () => {
	const workspace = await install.createWorkspace();
	const site = await install.createSite(workspace.id);
	const { api } = (await install.createStaff({ workspaces: [workspace.id] })).browser;
	const connected = await api.imports.connect({
		siteId: site.id,
		source: "wordpress-import.live",
		name: "Repeat",
		address: "https://live.example",
		username: "writer",
		applicationPassword: "one-time-password",
	});
	await install.drainJobs();
	const { file } = await api.imports.file({ siteId: site.id, fileId: connected.file.id });
	await api.imports.update({ siteId: site.id, importId: connected.importId, settings: required(file.suggested) });
	const started = await api.imports.start({ siteId: site.id, importId: connected.importId, fileId: file.id });
	await install.drainJobs();
	const { run } = await api.imports.report({ siteId: site.id, runId: started.run.id });
	expect(run.status).toBe("done");
	expect(run.counts.created).toBe(1);
	expect(run.warnings).toContain("restCustomFields");
	const next = await api.imports.connect({
		siteId: site.id,
		source: "wordpress-import.live",
		name: "Repeat",
		importId: connected.importId,
	});
	await install.drainJobs();
	const second = await api.imports.start({ siteId: site.id, importId: connected.importId, fileId: next.file.id });
	await install.drainJobs();
	const result = (await api.imports.report({ siteId: site.id, runId: second.run.id })).run;
	expect(result.counts.created).toBe(0);
	expect(result.counts.updated + result.counts.unchanged).toBe(1);
	expect(result.created).toEqual([]);
});

test("visibility is explicit, source-bound and partial REST reads never become ready", async () => {
	const workspace = await install.createWorkspace();
	const site = await install.createSite(workspace.id);
	const { api } = (await install.createStaff({ workspaces: [workspace.id] })).browser;
	install.dns.answer("private.example", [OLD_SITE_ADDRESS]);
	let truncated = false;
	let broadened = false;
	install.http.respond("GET", /^https:\/\/private.example\//, (request) => {
		const url = new URL(request.url);
		if (url.pathname.endsWith("/users/me")) return { body: '{"roles":["administrator"]}' };
		if (url.pathname.endsWith("/types")) return { body: '{"post":{"name":"Posts","rest_base":"posts"}}' };
		if (url.pathname.endsWith("/taxonomies")) return { body: "{}" };
		const hidden = url.searchParams.get("status")?.includes("private");
		const all = [
			{ id: 1, status: broadened ? "private" : "publish", title: { rendered: "Public" }, slug: "public" },
			...(hidden ? [{ id: 2, status: "private", title: { raw: "Private" }, slug: "private" }] : []),
		];
		const per = Number(url.searchParams.get("per_page"));
		return {
			body: JSON.stringify(truncated && per > 1 ? [] : all.slice(0, per)),
			headers: { "x-wp-total": String(all.length), "x-wp-totalpages": String(Math.ceil(all.length / per)) },
		};
	});
	const common = {
		siteId: site.id,
		source: "wordpress-import.live",
		name: "Private",
		address: "https://private.example",
		username: "editor",
		applicationPassword: "application-secret",
	};
	const publicOnly = await api.imports.connect(common);
	await install.drainJobs();
	expect((await api.imports.file({ siteId: site.id, fileId: publicOnly.file.id })).file.survey?.items).toBe(1);
	const hidden = await api.imports.connect({ ...common, includeHidden: true });
	await install.drainJobs();
	expect((await api.imports.file({ siteId: site.id, fileId: hidden.file.id })).file.survey?.items).toBe(2);
	await expect(
		api.imports.connect({ ...common, importId: hidden.importId, address: "https://elsewhere.example" }),
	).rejects.toMatchObject({ code: "IMPORT_INVALID" });
	const full = (await api.imports.file({ siteId: site.id, fileId: hidden.file.id })).file;
	await api.imports.update({ siteId: site.id, importId: publicOnly.importId, settings: required(full.suggested) });
	await expect(
		api.imports.start({ siteId: site.id, importId: publicOnly.importId, fileId: full.id }),
	).rejects.toMatchObject({ code: "IMPORT_FILE_NOT_READY" });
	const previewInput = {
		siteId: site.id,
		importId: hidden.importId,
		fileId: full.id,
		settings: required(full.suggested),
	};
	await api.imports.previewSource(previewInput);
	await install.drainJobs();
	expect((await api.imports.previewSource(previewInput)).preview).toMatchObject({
		status: "ready",
		types: [{ type: "post", create: 2 }],
	});
	await api.imports.update({ siteId: site.id, importId: hidden.importId, settings: required(full.suggested) });
	const { run } = await api.imports.start({ siteId: site.id, importId: hidden.importId, fileId: full.id });
	await install.drainJobs();
	expect((await api.imports.report({ siteId: site.id, runId: run.id })).run).toMatchObject({
		status: "done",
		counts: { created: 2 },
	});
	truncated = true;
	const partial = await api.imports.connect({ ...common, includeHidden: true });
	await install.drainJobs();
	const refused = (await api.imports.file({ siteId: site.id, fileId: partial.file.id })).file;
	expect(refused.status).toBe("refused");
	expect(refused.refusal?.code).toBe("pagination");
	await expect(
		api.imports.previewSource({ siteId: site.id, fileId: refused.id, settings: required(full.suggested) }),
	).rejects.toMatchObject({ code: "IMPORT_FILE_NOT_READY" });
	truncated = false;
	broadened = true;
	const broadenedSource = await api.imports.connect(common);
	await install.drainJobs();
	expect((await api.imports.file({ siteId: site.id, fileId: broadenedSource.file.id })).file).toMatchObject({
		status: "refused",
		refusal: { code: "visibility" },
	});
});

test("guarded calls refuse credentials in addresses, private DNS, redirects, authentication and oversized replies", async () => {
	const workspace = await install.createWorkspace();
	const site = await install.createSite(workspace.id);
	const { api } = (await install.createStaff({ workspaces: [workspace.id] })).browser;
	const input = {
		siteId: site.id,
		source: "wordpress-import.live",
		name: "Refusals",
		username: "login",
		applicationPassword: "private-login-password",
	};
	for (const address of [
		"http://live.example",
		"https://login:password@live.example",
		"https://live.example/?password=oops",
	])
		await expect(api.imports.connect({ ...input, address })).rejects.toMatchObject({ code: "IMPORT_INVALID" });
	install.dns.answer("internal.example", ["127.0.0.1"]);
	await expect(api.imports.connect({ ...input, address: "https://internal.example" })).rejects.toMatchObject({
		code: "IMPORT_INVALID",
	});
	expect(install.http.requests.some((r) => r.url.includes("internal.example"))).toBe(false);
	install.dns.answer("refuse.example", [OLD_SITE_ADDRESS]);
	for (const answer of [
		{ status: 302, headers: { location: "https://unrelated.example/steal" } },
		{ status: 401, body: "private-login-password" },
		{ status: 403 },
		{ status: 429 },
		{ status: 500 },
		{ status: 200, headers: { "content-length": "999999999" } },
		{ status: 200, body: "<html>Not REST</html>" },
	] as FakeAnswer[]) {
		install.http.respond("GET", /^https:\/\/refuse.example\//, answer);
		await expect(api.imports.connect({ ...input, address: "https://refuse.example" })).rejects.toMatchObject({
			code: "IMPORT_INVALID",
		});
	}
	expect(install.http.requests.some((r) => r.url.includes("unrelated.example"))).toBe(false);
	expect(JSON.stringify(install.logs)).not.toContain("private-login-password");
});

test("a paginated source stops on a rate limit and can be retried without creating partial Entries", async () => {
	const workspace = await install.createWorkspace();
	const site = await install.createSite(workspace.id);
	const { api } = (await install.createStaff({ workspaces: [workspace.id] })).browser;
	install.dns.answer("paged.example", [OLD_SITE_ADDRESS]);
	let limited = true;
	install.http.respond("GET", /^https:\/\/paged.example\//, (request) => {
		const url = new URL(request.url);
		if (url.pathname.endsWith("/users/me")) return { body: '{"roles":["editor"]}' };
		if (url.pathname.endsWith("/types")) return { body: '{"post":{"name":"Posts","rest_base":"posts"}}' };
		if (url.pathname.endsWith("/taxonomies")) return { body: "{}" };
		const page = Number(url.searchParams.get("page"));
		const per = Number(url.searchParams.get("per_page"));
		if (page === 2 && limited) return { status: 429 };
		const items = Array.from({ length: Math.max(0, Math.min(per, 101 - (page - 1) * per)) }, (_, i) => ({
			id: (page - 1) * per + i + 1,
			status: "publish",
			slug: `post-${(page - 1) * per + i + 1}`,
			title: { rendered: `Post ${(page - 1) * per + i + 1}` },
		}));
		return {
			body: JSON.stringify(items),
			headers: { "x-wp-total": "101", "x-wp-totalpages": String(Math.ceil(101 / per)) },
		};
	});
	const first = await api.imports.connect({
		siteId: site.id,
		name: "Paged",
		source: "wordpress-import.live",
		address: "https://paged.example",
		username: "login",
		applicationPassword: "application-password",
	});
	await install.drainJobs();
	expect((await api.imports.file({ siteId: site.id, fileId: first.file.id })).file).toMatchObject({
		status: "refused",
		refusal: { code: "rateLimit" },
	});
	expect((await api.postTypes.list({ siteId: site.id })).postTypes.some((p) => p.name === "Posts")).toBe(false);
	limited = false;
	const retried = await api.imports.refresh({ siteId: site.id, importId: first.importId });
	await install.drainJobs();
	const { file } = await api.imports.file({ siteId: site.id, fileId: retried.file.id });
	expect(file.survey?.items).toBe(101);
	await api.imports.update({ siteId: site.id, importId: first.importId, settings: required(file.suggested) });
	const { run } = await api.imports.start({ siteId: site.id, importId: first.importId, fileId: file.id });
	await api.imports.stop({ siteId: site.id, runId: run.id });
	await install.drainJobs();
	expect((await api.imports.report({ siteId: site.id, runId: run.id })).run).toMatchObject({
		status: "stopped",
		counts: { created: 0 },
	});
	const again = await api.imports.refresh({ siteId: site.id, importId: first.importId });
	await install.drainJobs();
	const started = await api.imports.start({ siteId: site.id, importId: first.importId, fileId: again.file.id });
	await install.drainJobs();
	expect((await api.imports.report({ siteId: site.id, runId: started.run.id })).run).toMatchObject({
		status: "done",
		counts: { created: 101 },
	});
	const preview = await api.imports.undo({ siteId: site.id, runId: started.run.id });
	if (preview.undone) throw new Error("Undo should ask first");
	await api.imports.undo({ siteId: site.id, runId: started.run.id, confirmation: preview.confirmation.id });
	expect((await api.imports.get({ siteId: site.id, importId: first.importId })).import.entries).toBe(0);
});

test("Pages whose parent has a later Source id keep their hierarchy", async () => {
	const workspace = await install.createWorkspace();
	const site = await install.createSite(workspace.id);
	const { api } = (await install.createStaff({ workspaces: [workspace.id] })).browser;
	install.dns.answer("pages.example", [OLD_SITE_ADDRESS]);
	const pages = [
		{
			id: 1,
			status: "publish",
			parent: 2,
			slug: "child",
			title: { rendered: "Child" },
			link: "https://pages.example/parent/child",
		},
		{
			id: 2,
			status: "publish",
			parent: 0,
			slug: "parent",
			title: { rendered: "Parent" },
			link: "https://pages.example/parent",
		},
	];
	install.http.respond("GET", /^https:\/\/pages.example\//, (r) => {
		const url = new URL(r.url);
		if (url.pathname.endsWith("/users/me")) return { body: '{"roles":["administrator"]}' };
		if (url.pathname.endsWith("/types")) return { body: '{"page":{"name":"Pages","rest_base":"pages"}}' };
		if (url.pathname.endsWith("/taxonomies")) return { body: "{}" };
		if (url.pathname.endsWith("/pages/2")) return { body: JSON.stringify(pages[1]) };
		const per = Number(url.searchParams.get("per_page"));
		return {
			body: JSON.stringify(pages.slice(0, per)),
			headers: { "x-wp-total": "2", "x-wp-totalpages": String(Math.ceil(2 / per)) },
		};
	});
	const connected = await api.imports.connect({
		siteId: site.id,
		source: "wordpress-import.live",
		name: "Pages",
		address: "https://pages.example",
		username: "login",
		applicationPassword: "application-password",
	});
	await install.drainJobs();
	const { file } = await api.imports.file({ siteId: site.id, fileId: connected.file.id });
	await api.imports.update({ siteId: site.id, importId: connected.importId, settings: required(file.suggested) });
	const { run } = await api.imports.start({ siteId: site.id, importId: connected.importId, fileId: file.id });
	await install.drainJobs();
	expect((await api.imports.report({ siteId: site.id, runId: run.id })).run.problems).toEqual([]);
	const postType = required(
		(await api.postTypes.list({ siteId: site.id })).postTypes.find((p) => p.builtIn === "page"),
	);
	const { entries } = await api.entries.list({ siteId: site.id, postTypeId: postType.id });
	const parent = required(entries.find((e) => e.draft.title === "Parent"));
	const child = required(entries.find((e) => e.draft.title === "Child"));
	expect(child.draft.parentId).toBe(parent.id);
});

test("source permissions, token Toolsets, Module off and worker actor rechecks are enforced", async () => {
	const workspace = await install.createWorkspace();
	const site = await install.createSite(workspace.id);
	const staff = await install.createStaff({ workspaces: [workspace.id] });
	const api = staff.browser.api;
	const owner = (await install.createMember({ workspaceId: workspace.id, role: "owner" })).browser.api;
	const input = {
		siteId: site.id,
		source: "wordpress-import.live",
		name: "Permissions",
		address: "https://live.example",
		username: "writer",
		applicationPassword: "one-time-password",
	};
	await expect(owner.imports.connect(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
	const connected = await api.imports.connect(input);
	const { secret } = await createApiToken(staff.browser, {
		workspaceId: workspace.id,
		name: "Content only",
		toolsets: ["content"],
	});
	const token = tokenClient(install, secret).api;
	await expect(token.imports.refresh({ siteId: site.id, importId: connected.importId })).rejects.toMatchObject({
		code: "TOOLSET_OFF",
	});
	const outsider = (await install.createStaff({ workspaces: [] })).browser.api;
	await expect(outsider.imports.refresh({ siteId: site.id, importId: connected.importId })).rejects.toMatchObject({
		code: "SITE_NOT_FOUND",
	});
	const switched = await api.imports.refresh({ siteId: site.id, importId: connected.importId });
	await api.modules.setOnSite({ siteId: site.id, moduleId: "wordpress-import", on: false });
	await expect(api.imports.refresh({ siteId: site.id, importId: connected.importId })).rejects.toMatchObject({
		code: "IMPORT_SOURCE_NOT_FOUND",
	});
	await install.drainJobs();
	await api.modules.setOnSite({ siteId: site.id, moduleId: "wordpress-import", on: true });
	expect((await api.imports.file({ siteId: site.id, fileId: switched.file.id })).file.status).toBe("refused");
	const recheck = await api.imports.refresh({ siteId: site.id, importId: connected.importId });
	const admin = await install.superadmin();
	await admin.api.staff.setWorkspaces({ personId: staff.personId, workspaces: [] });
	const before = install.http.requests.length;
	await install.drainJobs();
	expect(install.http.requests.length).toBe(before);
	await admin.api.staff.setWorkspaces({ personId: staff.personId, workspaces: [workspace.id] });
	expect((await api.imports.file({ siteId: site.id, fileId: recheck.file.id })).file.status).toBe("refused");
});

test("login use is audited, Site exports encrypt it, and transfers remap it to the new Import", async () => {
	const workspace = await install.createWorkspace();
	const site = await install.createSite(workspace.id);
	const staff = (await install.createStaff({ workspaces: [workspace.id] })).browser;
	const connected = await staff.api.imports.connect({
		siteId: site.id,
		source: "wordpress-import.live",
		name: "Portable",
		address: "https://live.example",
		username: "writer",
		applicationPassword: "one-time-password",
	});
	await install.drainJobs();
	const archive = await exportedArchive(install, staff, site.id, { passphrase: PASSPHRASE });
	expect(manifestIn(archive).secrets.names).toContain(`import:${connected.importId}:credentials`);
	for (const file of tarFiles(archive)) {
		const text = Buffer.from(file.path.endsWith(".gz") ? gunzipSync(file.data) : file.data).toString();
		expect(text).not.toContain("one-time-password");
		expect(text).not.toContain(Buffer.from("writer:one-time-password").toString("base64"));
	}
	const admin = await install.superadmin();
	const { entries } = await admin.api.audit.list({});
	expect(entries.some((e) => e.action === "import.credentials.use" && e.siteId === site.id)).toBe(true);
	expect(JSON.stringify(entries)).not.toContain("one-time-password");
	const imported = await importArchive(install, admin, workspace.id, archive, {
		name: "Copy",
		slug: "live-copy",
		passphrase: PASSPHRASE,
	});
	expect(imported.status).toBe("done");
	const newSite = required(imported.site).id;
	const copy = required((await admin.api.imports.list({ siteId: newSite })).imports.find((i) => i.name === "Portable"));
	expect(copy.id).not.toBe(connected.importId);
	expect((await admin.api.imports.refresh({ siteId: newSite, importId: copy.id })).connection.roles).toEqual([
		"editor",
	]);
	const dropped = await importArchive(install, admin, workspace.id, archive, { name: "No login", slug: "no-login" });
	expect(dropped.status).toBe("done");
	const noLogin = required((await admin.api.imports.list({ siteId: required(dropped.site).id })).imports[0]);
	await expect(
		admin.api.imports.refresh({ siteId: required(dropped.site).id, importId: noLogin.id }),
	).rejects.toMatchObject({
		code: "IMPORT_INVALID",
	});
});

test("removing an Import works with its Module off, requires Staff confirmation and keeps content", async () => {
	const workspace = await install.createWorkspace();
	const site = await install.createSite(workspace.id);
	const staff = (await install.createStaff({ workspaces: [workspace.id] })).browser;
	const connected = await staff.api.imports.connect({
		siteId: site.id,
		source: "wordpress-import.live",
		name: "Remove",
		address: "https://live.example",
		username: "writer",
		applicationPassword: "one-time-password",
	});
	await install.drainJobs();
	const { file } = await staff.api.imports.file({ siteId: site.id, fileId: connected.file.id });
	await staff.api.imports.update({ siteId: site.id, importId: connected.importId, settings: required(file.suggested) });
	await staff.api.imports.start({ siteId: site.id, importId: connected.importId, fileId: file.id });
	await install.drainJobs();
	await staff.api.modules.setOnSite({ siteId: site.id, moduleId: "wordpress-import", on: false });
	const first = await staff.api.imports.remove({ siteId: site.id, importId: connected.importId });
	expect(first.removed).toBe(false);
	if (first.removed) throw new Error("No confirmation");
	const owner = (await install.createMember({ workspaceId: workspace.id, role: "owner" })).browser;
	await expect(owner.api.imports.remove({ siteId: site.id, importId: connected.importId })).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	await staff.api.imports.remove({
		siteId: site.id,
		importId: connected.importId,
		confirmation: first.confirmation.id,
	});
	expect((await staff.api.imports.list({ siteId: site.id })).imports).toEqual([]);
	const posts = required(
		(await staff.api.postTypes.list({ siteId: site.id })).postTypes.find((p) => p.name === "Posts"),
	);
	expect((await staff.api.entries.list({ siteId: site.id, postTypeId: posts.id })).entries).toHaveLength(1);
	expect(manifestIn(await exportedArchive(install, staff, site.id)).secrets.names).not.toContain(
		`import:${connected.importId}:credentials`,
	);
});

test("credentials expire 30 days after the last run, including when the Module is off", async () => {
	const day = 86400_000;
	const workspace = await install.createWorkspace();
	const site = await install.createSite(workspace.id);
	const person = await install.createStaff({ workspaces: [workspace.id] });
	let staff = person.browser;
	const connected = await staff.api.imports.connect({
		siteId: site.id,
		source: "wordpress-import.live",
		name: "Expiry",
		address: "https://live.example",
		username: "writer",
		applicationPassword: "one-time-password",
	});
	await install.clock.advance(29 * day);
	await install.drainJobs();
	staff = await install.signIn(person.account);
	const fresh = await staff.api.imports.refresh({ siteId: site.id, importId: connected.importId });
	await install.drainJobs();
	const { file } = await staff.api.imports.file({ siteId: site.id, fileId: fresh.file.id });
	await staff.api.imports.update({ siteId: site.id, importId: connected.importId, settings: required(file.suggested) });
	await staff.api.imports.start({ siteId: site.id, importId: connected.importId, fileId: file.id });
	await install.drainJobs();
	await install.clock.advance(2 * day);
	await install.drainJobs();
	staff = await install.signIn(person.account);
	expect(manifestIn(await exportedArchive(install, staff, site.id)).secrets.names).toContain(
		`import:${connected.importId}:credentials`,
	);
	await staff.api.modules.setOnSite({ siteId: site.id, moduleId: "wordpress-import", on: false });
	await install.clock.advance(29 * day);
	await install.drainJobs();
	staff = await install.signIn(person.account);
	expect(manifestIn(await exportedArchive(install, staff, site.id)).secrets.names).not.toContain(
		`import:${connected.importId}:credentials`,
	);
	await staff.api.modules.setOnSite({ siteId: site.id, moduleId: "wordpress-import", on: true });
	await expect(staff.api.imports.refresh({ siteId: site.id, importId: connected.importId })).rejects.toMatchObject({
		code: "IMPORT_INVALID",
	});
});

test("public Media surveys and Media retrieval carry no login, and Preview fetches no files", async () => {
	const workspace = await install.createWorkspace();
	const site = await install.createSite(workspace.id);
	const staff = (await install.createStaff({ workspaces: [workspace.id] })).browser;
	install.dns.answer("media-source.example", [OLD_SITE_ADDRESS]);
	install.dns.answer("cdn.example", [OLD_SITE_ADDRESS]);
	install.http.respond("GET", /^https:\/\/media-source.example\//, (r) => {
		const url = new URL(r.url);
		if (url.pathname.endsWith("/users/me")) return { body: '{"roles":["editor"]}' };
		if (url.pathname.endsWith("/types")) return { body: '{"attachment":{"name":"Media","rest_base":"media"}}' };
		if (url.pathname.endsWith("/taxonomies")) return { body: "{}" };
		expect(r.headers.has("authorization")).toBe(false);
		return {
			body: '[{"id":9,"status":"inherit","source_url":"https://cdn.example/photo.png","title":{"rendered":"Photo"},"alt_text":"A loaf"}]',
			headers: { "x-wp-total": "1", "x-wp-totalpages": "1" },
		};
	});
	const bytes = await photo({ width: 32, height: 32, format: "png" });
	install.http.respond("GET", "https://cdn.example/photo.png", (r) => {
		expect(r.headers.has("authorization")).toBe(false);
		return { body: bytes, headers: { "content-type": "image/png" } };
	});
	const connected = await staff.api.imports.connect({
		siteId: site.id,
		source: "wordpress-import.live",
		name: "Media",
		address: "https://media-source.example",
		username: "login",
		applicationPassword: "media-application-password",
	});
	await install.drainJobs();
	const { file } = await staff.api.imports.file({ siteId: site.id, fileId: connected.file.id });
	expect(file.status).toBe("ready");
	const input = { siteId: site.id, fileId: file.id, settings: required(file.suggested), importId: connected.importId };
	await staff.api.imports.previewSource(input);
	await install.drainJobs();
	expect((await staff.api.imports.previewSource(input)).preview).toMatchObject({ status: "ready", files: 1 });
	expect(install.http.requests.some((r) => r.url === "https://cdn.example/photo.png")).toBe(false);
	await staff.api.imports.update({ siteId: site.id, importId: connected.importId, settings: required(file.suggested) });
	const { run } = await staff.api.imports.start({ siteId: site.id, importId: connected.importId, fileId: file.id });
	await install.drainJobs();
	expect((await staff.api.imports.report({ siteId: site.id, runId: run.id })).run).toMatchObject({
		status: "done",
		files: 1,
		notFetchedTotal: 0,
	});
});
