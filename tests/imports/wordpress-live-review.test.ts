import { expect, test } from "bun:test";
import type { FakeAnswer } from "../harness/fake-http.ts";
import { createTestInstall } from "../harness/index.ts";
import { approveModules, OLD_SITE_ADDRESS } from "./wordpress.ts";

function required<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error("Expected a public response value.");
	return value;
}

test("parent visibility is checked both on lookup and when an already-yielded parent appears on its page", async () => {
	const install = await createTestInstall();
	try {
		await approveModules(install);
		const workspace = await install.createWorkspace();
		const site = await install.createSite(workspace.id);
		const { api } = (await install.createStaff({ workspaces: [workspace.id] })).browser;
		install.dns.answer("parent-visibility.example", [OLD_SITE_ADDRESS]);
		let privateLookup = false;
		install.http.respond("GET", /^https:\/\/parent-visibility.example\//, (request) => {
			const url = new URL(request.url);
			if (url.pathname.endsWith("/users/me")) return { body: '{"roles":["editor"]}' };
			if (url.pathname.endsWith("/types")) return { body: '{"page":{"name":"Pages","rest_base":"pages"}}' };
			if (url.pathname.endsWith("/taxonomies")) return { body: "{}" };
			const parent = { id: 2, title: { rendered: "Parent" }, slug: "parent", status: "private" };
			if (url.pathname.endsWith("/pages/2"))
				return { body: JSON.stringify({ ...parent, status: privateLookup ? "private" : "publish" }) };
			const per = Number(url.searchParams.get("per_page"));
			return {
				body: JSON.stringify(
					[{ id: 1, parent: 2, status: "publish", title: { rendered: "Child" }, slug: "child" }, parent].slice(0, per),
				),
				headers: { "x-wp-total": "2", "x-wp-totalpages": String(Math.ceil(2 / per)) },
			};
		});
		for (const onLookup of [true, false]) {
			privateLookup = onLookup;
			const connected = await api.imports.connect({
				siteId: site.id,
				source: "wordpress-import.live",
				name: "Parent visibility",
				address: "https://parent-visibility.example",
				username: "editor",
				applicationPassword: "parent-login",
			});
			await install.drainJobs();
			expect((await api.imports.file({ siteId: site.id, fileId: connected.file.id })).file).toMatchObject({
				status: "refused",
				refusal: { code: "visibility" },
			});
		}
	} finally {
		await install.close();
	}
});

test("REST discovery refuses unsafe roots and failed responses before sending a login", async () => {
	const install = await createTestInstall();
	try {
		await approveModules(install);
		const workspace = await install.createWorkspace();
		const site = await install.createSite(workspace.id);
		const { api } = (await install.createStaff({ workspaces: [workspace.id] })).browser;
		const address = "https://discovery-guard.example/journal/";
		install.dns.answer("discovery-guard.example", [OLD_SITE_ADDRESS]);
		const link = (root: string) => `<${root}>; rel="https://api.w.org/"`;
		const answers: FakeAnswer[] = [
			...[
				"https://other.example/journal/wp-json/",
				"http://discovery-guard.example/journal/wp-json/",
				"https://discovery-guard.example:8443/journal/wp-json/",
				"https://user:pass@discovery-guard.example/journal/wp-json/",
				"https://127.0.0.1/journal/wp-json/",
				"/journal/wp-json/#fragment",
				"/wp-json/",
				"/other/wp-json/",
				"/journal/wp-admin/",
				"/journal/proxy?rest_route=/",
				"/journal/?rest_route=/&redirect=elsewhere",
				"/journal/?rest_route=/&rest_route=/wp/v2/users",
				"/journal/?rest.route=/",
				"/journal/?rest_route=/wp/v2/users",
				"/journal/%77p-json/",
			].map((root) => ({ headers: { link: link(root) } })),
			{ headers: { link: `${link("/journal/wp-json/")}, ${link("/journal/?rest_route=/")}` } },
			{ status: 302, headers: { location: "https://other.example/", link: link("/journal/wp-json/") } },
			{ status: 500, headers: { link: link("/journal/wp-json/") } },
			{ headers: { link: `${link("/journal/wp-json/")}; title="${"x".repeat(17 * 1024)}"` } },
			{ body: "x".repeat(65 * 1024), headers: { link: link("/journal/wp-json/") } },
		];
		for (const answer of answers) {
			install.http.respond("HEAD", address, answer);
			const before = install.http.requests.length;
			await expect(
				api.imports.connect({
					siteId: site.id,
					source: "wordpress-import.live",
					name: "Refused discovery",
					address,
					username: "editor",
					applicationPassword: "source-only-login",
				}),
			).rejects.toMatchObject({ code: "IMPORT_INVALID" });
			const calls = install.http.requests.slice(before);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.url).toBe(address);
			expect(calls[0]?.method).toBe("HEAD");
			expect(calls[0]?.headers.has("authorization")).toBe(false);
		}
	} finally {
		await install.close();
	}
});

test("filtered Media still refuses changed totals, duplicates, oversized pages and partial failures", async () => {
	const install = await createTestInstall();
	try {
		await approveModules(install);
		const workspace = await install.createWorkspace();
		const site = await install.createSite(workspace.id);
		const { api } = (await install.createStaff({ workspaces: [workspace.id] })).browser;
		install.dns.answer("media-failures.example", [OLD_SITE_ADDRESS]);
		let failure = "";
		let lastPage = 0;
		install.http.respond("GET", /^https:\/\/media-failures.example\//, (request) => {
			const url = new URL(request.url);
			if (url.pathname.endsWith("/users/me")) return { body: '{"roles":["editor"]}' };
			if (url.pathname.endsWith("/types")) return { body: '{"attachment":{"name":"Media","rest_base":"media"}}' };
			if (url.pathname.endsWith("/taxonomies")) return { body: "{}" };
			expect(request.headers.has("authorization")).toBe(false);
			const per = Number(url.searchParams.get("per_page"));
			const page = Number(url.searchParams.get("page"));
			const final = per === 100 && page === 3;
			if (per === 100) lastPage = page;
			if (final && failure === "rateLimit") return { status: 429 };
			if (final && failure === "response") return { body: "not JSON" };
			const ids = per === 1 || page === 1 ? [] : page === 2 || failure === "duplicates" ? [101] : [201];
			if (final && failure === "oversized") ids.push(202);
			return {
				body: JSON.stringify(ids.map((id) => ({ id, source_url: `https://media-failures.example/${id}.jpg` }))),
				headers: {
					"x-wp-total": final && failure === "totals" ? "202" : "201",
					"x-wp-totalpages": String(Math.ceil(201 / per)),
				},
			};
		});
		for (const problem of ["totals", "duplicates", "oversized", "rateLimit", "response"]) {
			failure = problem;
			lastPage = 0;
			const connected = await api.imports.connect({
				siteId: site.id,
				source: "wordpress-import.live",
				name: `Refused Media ${problem}`,
				address: "https://media-failures.example",
				username: "editor",
				applicationPassword: "media-login",
			});
			await install.drainJobs();
			const { file } = await api.imports.file({ siteId: site.id, fileId: connected.file.id });
			expect(lastPage).toBe(3);
			expect(file).toMatchObject({
				status: "refused",
				refusal: { code: ["rateLimit", "response"].includes(problem) ? problem : "pagination" },
			});
			await expect(
				api.imports.previewSource({
					siteId: site.id,
					importId: connected.importId,
					fileId: file.id,
					settings: { language: null, types: [] },
				}),
			).rejects.toMatchObject({ code: "IMPORT_FILE_NOT_READY" });
		}
	} finally {
		await install.close();
	}
});

for (const includeHidden of [false, true]) {
	test(`permission-filtered ${includeHidden ? "authenticated" : "public"} Media traverses every advertised page without widening access`, async () => {
		const install = await createTestInstall();
		try {
			await approveModules(install);
			const workspace = await install.createWorkspace();
			const site = await install.createSite(workspace.id);
			const { api } = (await install.createStaff({ workspaces: [workspace.id] })).browser;
			install.dns.answer("filtered-media.example", [OLD_SITE_ADDRESS]);
			const pages: number[] = [];
			install.http.respond("GET", /^https:\/\/filtered-media.example\//, (request) => {
				const url = new URL(request.url);
				if (url.pathname.endsWith("/users/me")) return { body: '{"roles":["editor"]}' };
				if (url.pathname.endsWith("/types")) return { body: '{"attachment":{"name":"Media","rest_base":"media"}}' };
				if (url.pathname.endsWith("/taxonomies")) return { body: "{}" };
				expect(request.headers.has("authorization")).toBe(includeHidden);
				expect(url.searchParams.get("context")).toBe(includeHidden ? "edit" : "view");
				const per = Number(url.searchParams.get("per_page"));
				const page = Number(url.searchParams.get("page"));
				if (per === 100) pages.push(page);
				// WordPress pages WP_Query first, then omits attachments with unreadable parents.
				// All first-page attachments are private; later pages each contain a public one.
				const visible = [101, 201].filter((id) => id > (page - 1) * per && id <= page * per);
				return {
					body: JSON.stringify(
						visible.map((id) => ({
							id,
							status: "inherit",
							post: 9,
							source_url: `https://filtered-media.example/${id}.jpg`,
							title: { rendered: `Public ${id}` },
						})),
					),
					headers: { "x-wp-total": "201", "x-wp-totalpages": String(Math.ceil(201 / per)) },
				};
			});
			const connected = await api.imports.connect({
				siteId: site.id,
				source: "wordpress-import.live",
				name: "Public Media",
				address: "https://filtered-media.example",
				username: "editor",
				applicationPassword: "media-login",
				includeHidden,
			});
			expect(connected.connection.types).toEqual([{ key: "attachment", label: "Media", count: 201 }]);
			await install.drainJobs();
			const { file } = await api.imports.file({ siteId: site.id, fileId: connected.file.id });
			expect(file.status).toBe("ready");
			expect(file.survey?.items).toBe(2);
			expect(pages).toEqual([1, 2, 3]);
			const input = {
				siteId: site.id,
				importId: connected.importId,
				fileId: file.id,
				settings: required(file.suggested),
			};
			await api.imports.previewSource(input);
			await install.drainJobs();
			const { preview } = await api.imports.previewSource(input);
			expect(preview.status).toBe("ready");
			expect(preview.media.map((item) => item.title)).toEqual(["Public 101", "Public 201"]);
		} finally {
			await install.close();
		}
	});
}

test("samples and Preview require their live Import and its current visibility revision", async () => {
	const install = await createTestInstall();
	try {
		await approveModules(install);
		const workspace = await install.createWorkspace();
		const site = await install.createSite(workspace.id);
		const { api } = (await install.createStaff({ workspaces: [workspace.id] })).browser;
		install.dns.answer("bound-preview.example", [OLD_SITE_ADDRESS]);
		install.http.respond("GET", /^https:\/\/bound-preview.example\//, (request) => {
			const url = new URL(request.url);
			if (url.pathname.endsWith("/users/me")) return { body: '{"roles":["editor"]}' };
			if (url.pathname.endsWith("/types")) return { body: '{"post":{"name":"Posts","rest_base":"posts"}}' };
			if (url.pathname.endsWith("/taxonomies")) return { body: "{}" };
			const rows = [
				{ id: 1, status: "publish", title: { rendered: "Public" }, slug: "public" },
				...(url.searchParams.get("status")?.includes("private")
					? [{ id: 2, status: "private", title: { raw: "Private" }, slug: "private" }]
					: []),
			];
			const per = Number(url.searchParams.get("per_page"));
			return {
				body: JSON.stringify(rows.slice(0, per)),
				headers: {
					"x-wp-total": String(rows.length),
					"x-wp-totalpages": String(Math.ceil(rows.length / per)),
				},
			};
		});
		const common = {
			siteId: site.id,
			source: "wordpress-import.live",
			name: "Bound Preview",
			address: "https://bound-preview.example",
			username: "editor",
			applicationPassword: "preview-login",
		};
		const publicOnly = await api.imports.connect(common);
		const hidden = await api.imports.connect({ ...common, includeHidden: true });
		await install.drainJobs();
		const { file } = await api.imports.file({ siteId: site.id, fileId: hidden.file.id });
		const input = { siteId: site.id, fileId: file.id, settings: required(file.suggested) };
		for (const importId of [publicOnly.importId, null]) {
			await expect(api.imports.previewSource({ ...input, importId })).rejects.toMatchObject({
				code: "IMPORT_FILE_NOT_READY",
			});
			await expect(api.imports.sample({ ...input, importId, type: "post", index: 1 })).rejects.toMatchObject({
				code: "IMPORT_FILE_NOT_READY",
			});
		}
		const allowed = { ...input, importId: hidden.importId };
		expect((await api.imports.sample({ ...allowed, type: "post", index: 1 })).sample.entry?.title).toBe("Private");
		await api.imports.previewSource(allowed);
		await install.drainJobs();
		expect((await api.imports.previewSource(allowed)).preview.entries.map((entry) => entry.title)).toEqual([
			"Public",
			"Private",
		]);
		const fresh = await api.imports.connect({ ...common, importId: hidden.importId, includeHidden: false });
		await install.drainJobs();
		await expect(api.imports.previewSource(allowed)).rejects.toMatchObject({ code: "IMPORT_FILE_NOT_FOUND" });
		await expect(api.imports.sample({ ...allowed, type: "post", index: 1 })).rejects.toMatchObject({
			code: "IMPORT_FILE_NOT_FOUND",
		});
		const latest = (await api.imports.file({ siteId: site.id, fileId: fresh.file.id })).file;
		const current = { ...allowed, fileId: latest.id, settings: required(latest.suggested) };
		await api.imports.previewSource(current);
		await install.drainJobs();
		expect((await api.imports.previewSource(current)).preview.entries.map((entry) => entry.title)).toEqual(["Public"]);
	} finally {
		await install.close();
	}
});

test("rendered titles use shared HTML conversion while raw titles remain literal", async () => {
	const install = await createTestInstall();
	try {
		await approveModules(install);
		const workspace = await install.createWorkspace();
		const site = await install.createSite(workspace.id);
		const { api } = (await install.createStaff({ workspaces: [workspace.id] })).browser;
		install.dns.answer("rendered-title.example", [OLD_SITE_ADDRESS]);
		install.http.respond("GET", /^https:\/\/rendered-title.example\//, (request) => {
			const url = new URL(request.url);
			if (url.pathname.endsWith("/users/me")) return { body: '{"roles":["editor"]}' };
			if (url.pathname.endsWith("/types")) return { body: '{"post":{"name":"Posts","rest_base":"posts"}}' };
			if (url.pathname.endsWith("/taxonomies")) return { body: "{}" };
			const rows = [
				{
					id: 1,
					status: "publish",
					slug: "rendered",
					title: { rendered: "Bread &amp; butter &#8211; &#x1F35E; &eacute; <em>today</em> &amp;amp;" },
				},
				{
					id: 2,
					status: "draft",
					slug: "raw",
					title: { raw: "Raw &amp; <em>literal</em>", rendered: "Wrong rendered value" },
				},
			];
			const per = Number(url.searchParams.get("per_page"));
			return {
				body: JSON.stringify(rows.slice(0, per)),
				headers: { "x-wp-total": "2", "x-wp-totalpages": String(Math.ceil(2 / per)) },
			};
		});
		const connected = await api.imports.connect({
			siteId: site.id,
			source: "wordpress-import.live",
			name: "Titles",
			address: "https://rendered-title.example",
			username: "editor",
			applicationPassword: "title-login",
			includeHidden: true,
		});
		await install.drainJobs();
		const { file } = await api.imports.file({ siteId: site.id, fileId: connected.file.id });
		const input = {
			siteId: site.id,
			fileId: file.id,
			importId: connected.importId,
			settings: required(file.suggested),
		};
		expect((await api.imports.sample({ ...input, type: "post", index: 0 })).sample.entry?.title).toBe(
			"Bread & butter – 🍞 é today &amp;",
		);
		expect((await api.imports.sample({ ...input, type: "post", index: 1 })).sample.entry?.title).toBe(
			"Raw &amp; <em>literal</em>",
		);
		expect(file.survey?.types[0]?.keys.find((key) => key.key === "title")?.count).toBe(2);
		await api.imports.previewSource(input);
		await install.drainJobs();
		expect((await api.imports.previewSource(input)).preview.entries.map((entry) => entry.title)).toEqual([
			"Bread & butter – 🍞 é today &amp;",
			"Raw &amp; <em>literal</em>",
		]);
		await api.imports.update({ siteId: site.id, importId: connected.importId, settings: input.settings });
		const { run } = await api.imports.start({ siteId: site.id, importId: connected.importId, fileId: file.id });
		await install.drainJobs();
		expect((await api.imports.report({ siteId: site.id, runId: run.id })).run).toMatchObject({
			status: "done",
			counts: { created: 2 },
		});
		const posts = required(
			(await api.postTypes.list({ siteId: site.id })).postTypes.find((type) => type.name === "Posts"),
		);
		expect(
			(await api.entries.list({ siteId: site.id, postTypeId: posts.id })).entries.map((entry) => entry.draft.title),
		).toEqual(expect.arrayContaining(["Bread & butter – 🍞 é today &amp;", "Raw &amp; <em>literal</em>"]));
	} finally {
		await install.close();
	}
});

for (const [folder, endpoint] of [
	["/", "/?rest_route=/"],
	["/", "/index.php?rest_route=/"],
	["/", "/wp-json/"],
	["/journal/", "/journal/?rest_route=/"],
	["/journal/", "/journal/index.php?rest_route=/"],
	["/journal/", "/journal/wp-json/"],
	["/journal/", "/journal/index.php/wp-json/"],
] as const) {
	test(`discovers the WordPress REST root ${endpoint} from Site address ${folder}`, async () => {
		const install = await createTestInstall();
		try {
			await approveModules(install);
			const workspace = await install.createWorkspace();
			const site = await install.createSite(workspace.id);
			const { api } = (await install.createStaff({ workspaces: [workspace.id] })).browser;
			const address = `https://rest-root.example${folder}`;
			const root = new URL(endpoint, address);
			install.dns.answer("rest-root.example", [OLD_SITE_ADDRESS]);
			install.http.respond("HEAD", address, (request) => {
				expect(request.headers.has("authorization")).toBe(false);
				return {
					headers: {
						link: `<https://rest-root.example/elsewhere>; rel="alternate"; title="A, B", <${root}>; rel="https://api.w.org/"`,
						"content-length": "262144",
					},
				};
			});
			install.http.respond("GET", /^https:\/\/rest-root.example\//, (request) => {
				const url = new URL(request.url);
				const plain = root.searchParams.has("rest_route");
				const route = plain ? url.searchParams.get("rest_route") : url.pathname.slice(root.pathname.length - 1);
				if (plain ? url.pathname !== root.pathname || !route : !url.pathname.startsWith(root.pathname))
					return { status: 404, body: "No REST route here" };
				expect(request.headers.get("authorization")).toBe(
					`Basic ${Buffer.from("editor:root-login").toString("base64")}`,
				);
				if (route === "/wp/v2/users/me") return { body: '{"roles":["editor"]}' };
				if (route === "/wp/v2/types") return { body: '{"post":{"name":"Posts","rest_base":"posts"}}' };
				if (route === "/wp/v2/taxonomies") return { body: "{}" };
				if (route !== "/wp/v2/posts") return { status: 404 };
				expect(url.searchParams.get("status")).toBe("publish");
				return {
					body: '[{"id":1,"status":"publish","title":{"rendered":"Discovered"},"slug":"discovered"}]',
					headers: { "x-wp-total": "1", "x-wp-totalpages": "1" },
				};
			});
			const connected = await api.imports.connect({
				siteId: site.id,
				source: "wordpress-import.live",
				name: "Discovery",
				address,
				username: "editor",
				applicationPassword: "root-login",
			});
			expect(connected.connection.roles).toEqual(["editor"]);
			await install.drainJobs();
			const { file } = await api.imports.file({ siteId: site.id, fileId: connected.file.id });
			expect(file.status).toBe("ready");
			expect(file.survey?.items).toBe(1);
			expect(install.http.requests.filter((request) => request.method === "HEAD")).toHaveLength(2);
			await api.imports.update({ siteId: site.id, importId: connected.importId, settings: required(file.suggested) });
			const { run } = await api.imports.start({ siteId: site.id, importId: connected.importId, fileId: file.id });
			await install.drainJobs();
			expect((await api.imports.report({ siteId: site.id, runId: run.id })).run).toMatchObject({
				status: "done",
				counts: { created: 1 },
			});
		} finally {
			await install.close();
		}
	});
}
