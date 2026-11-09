// The public Management API's OpenAPI document (`/api/v1/openapi.json`): every public procedure,
// never an internal one, with the marks the MCP server and the CLI are generated from. The
// document of a build with its first-party Modules is checked in at `docs/api/openapi.json`, so
// every change to the public API shows in review; `bun run api:document` writes it again.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { FIRST_PARTY_MODULES } from "@webcraft/core";

import { createTestInstall, type TestInstall } from "../harness/index.ts";

const CHECKED_IN = new URL("../../docs/api/openapi.json", import.meta.url);

type Operation = {
	operationId: string;
	summary: string;
	tags: string[];
	"x-webcraft-access": "read" | "write";
	"x-webcraft-sensitive"?: string;
	"x-webcraft-confirmation"?: true;
};
type Document = {
	openapi: string;
	servers: { url: string }[];
	paths: Record<string, Record<string, Operation>>;
	components: { securitySchemes: Record<string, unknown> };
	security: unknown[];
};

let install: TestInstall;
let document: Document;
let operations: Map<string, Operation & { method: string; path: string }>;

beforeAll(async () => {
	install = await createTestInstall({ modules: FIRST_PARTY_MODULES });
	const answer = await install.request(install.adminUrl("/api/v1/openapi.json"));
	expect(answer.status).toBe(200);
	document = (await answer.json()) as Document;
	operations = new Map(
		Object.entries(document.paths).flatMap(([path, methods]) =>
			Object.entries(methods).map(([method, operation]) => [operation.operationId, { ...operation, method, path }]),
		),
	);
});

afterAll(async () => {
	await install.close();
});

describe("the document", () => {
	test("is the checked-in document", async () => {
		if (process.env.WEBCRAFT_UPDATE_OPENAPI === "1") {
			await writeFile(CHECKED_IN, `${JSON.stringify(document, null, "\t")}\n`);
		}
		const checkedIn: unknown = JSON.parse(await readFile(CHECKED_IN, "utf8").catch(() => "null"));
		// When this fails, the public API changed: run `bun run api:document` and review the diff.
		expect(document).toEqual(checkedIn as Document);
	});

	test("describes calling each procedure with POST and an API token", () => {
		expect(document.openapi).toStartWith("3.1");
		expect(document.servers).toEqual([{ url: "/api/v1" }]);
		expect(document.components.securitySchemes).toEqual({ apiToken: { type: "http", scheme: "bearer" } });
		expect(document.security).toEqual([{ apiToken: [] }]);
		expect(operations.get("entries.publish")).toMatchObject({
			method: "post",
			path: "/entries/publish",
			tags: ["entries"],
		});
		expect(operations.get("m.redirects.rules.list")).toMatchObject({
			method: "post",
			path: "/m/redirects/rules/list",
			tags: ["m.redirects"],
			"x-webcraft-access": "read",
		});
		for (const operation of operations.values()) {
			expect(operation.method).toBe("post");
			expect(operation.summary.length).toBeGreaterThan(0);
			expect(["read", "write"]).toContain(operation["x-webcraft-access"]);
		}
	});

	test("lists public procedures and never the admin's own", () => {
		for (const internal of [
			"setup.claim",
			"session.signIn",
			"session.confirmIdentity",
			"shell.context",
			"me.sessions.list",
			"me.changePassword",
			"apiTokens.create",
			"apiTokens.list",
			"install.settings.update",
			"install.smtp.update",
			"workspaces.create",
			"staff.invite",
			"invites.accept",
			"audit.list",
			"modules.approve",
			"editMode.open",
		]) {
			expect({ internal, listed: operations.has(internal) }).toEqual({ internal, listed: false });
		}
		for (const procedure of ["sites.list", "entries.saveDraft", "templates.saveEntryTemplateMarkup", "media.upload"]) {
			expect({ procedure, listed: operations.has(procedure) }).toEqual({ procedure, listed: true });
		}
	});

	test("marks reads and writes", () => {
		expect(operations.get("entries.list")?.["x-webcraft-access"]).toBe("read");
		expect(operations.get("templates.getSiteTemplateMarkup")?.["x-webcraft-access"]).toBe("read");
		expect(operations.get("entries.saveDraft")?.["x-webcraft-access"]).toBe("write");
		expect(operations.get("m.redirects.rules.add")?.["x-webcraft-access"]).toBe("write");
	});

	test("marks Sensitive actions, which no token can take", () => {
		const sensitive = [...operations.values()]
			.filter((operation) => operation["x-webcraft-sensitive"])
			.map((operation) => [operation.operationId, operation["x-webcraft-sensitive"]]);
		expect(sensitive.sort()).toEqual(
			[
				["aiKeys.removeOwn", "aiKey.change"],
				["aiKeys.setOwn", "aiKey.change"],
				["forms.captcha.set", "formCaptcha.change"],
				["members.changeAccess", "member.changeAccess"],
				["members.invite", "member.invite"],
				["members.remove", "member.remove"],
				["siteSmtp.update", "siteSmtp.change"],
				["webhooks.add", "webhook.change"],
				["webhooks.changeSecret", "webhook.change"],
				["webhooks.update", "webhook.change"],
			].sort(),
		);
	});

	test("marks every destructive procedure as taking a preview and a confirmation", () => {
		// The spec's rule: publishing, emptying Trash, deleting Structure and changes reaching many
		// items or past undoing take two steps (Publish all comes with its own ticket).
		const destructive = [
			"entries.publish",
			"globals.publish",
			"templates.publish",
			"components.publish",
			"forms.publish",
			"forms.publishEmails",
			"loops.publish",
			"scripts.publish",
			"consentBanner.publish",
			"designSystem.publish",
			"entries.delete",
			"components.delete",
			"forms.delete",
			"designSystem.deleteClass",
			"libraries.remove",
			"media.delete",
			"media.deleteForever",
			"media.emptyTrash",
			"languages.remove",
			"languages.setDefault",
			"domains.remove",
			"webhooks.remove",
			"imports.undo",
			"modules.removeSiteData",
			"modules.removeWorkspaceData",
			"m.forms.submissions.delete",
		];
		const confirmed = [...operations.values()]
			.filter((operation) => operation["x-webcraft-confirmation"])
			.map((operation) => operation.operationId);
		expect(confirmed.sort()).toEqual(destructive.sort());
	});
});
