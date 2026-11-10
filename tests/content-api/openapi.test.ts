// The Content API's own OpenAPI document (`/_content/v1/openapi.json` on each Site that has the API
// on), separate from the Management API's. It is checked in at `docs/api/content-api.openapi.json`,
// so every change to the Content API shows in review; `bun run content-api:document` writes it again.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { CONTENT_API_ERRORS } from "@webcraft/core";

import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { type Bakery, bakery, contentClient } from "./support.ts";

const CHECKED_IN = new URL("../../docs/api/content-api.openapi.json", import.meta.url);

type Document = {
	openapi: string;
	servers: { url: string }[];
	paths: Record<string, Record<string, { operationId: string; responses: Record<string, unknown> }>>;
	"x-webcraft-errors": Record<string, { status: number }>;
};

let install: TestInstall;
let site: Bakery;
let document: Document;

beforeAll(async () => {
	install = await createTestInstall();
	site = await bakery(install, "bakery");
	const response = await contentClient(install, site.origin, null).get("/openapi.json");
	expect(response.status).toBe(200);
	document = (await response.json()) as Document;
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
		// When this fails, the Content API changed: run `bun run content-api:document` and review the diff.
		expect(document).toEqual(checkedIn as Document);
	});

	test("needs no key, and describes every path under /_content/v1 with its refusals", () => {
		expect(document.openapi).toStartWith("3.1");
		expect(document.servers).toEqual([{ url: "/_content/v1", description: expect.any(String) }]);
		expect(Object.keys(document.paths)).toEqual([
			"/entries/{postType}",
			"/entries/{postType}/{id}",
			"/entries/{postType}/slug/{slug}",
			"/entry",
			"/globals",
			"/media/{id}",
			"/search",
			"/languages",
			"/schema",
			"/openapi.json",
		]);
		expect(Object.keys(document.paths["/entries/{postType}"]?.get?.responses ?? {})).toEqual([
			"200",
			"304",
			"400",
			"401",
			"403",
			"404",
			"429",
		]);
		expect(Object.keys(document["x-webcraft-errors"])).toEqual(Object.keys(CONTENT_API_ERRORS));
	});

	test("is only served while the Site has the Content API on", async () => {
		await site.staff.api.contentApi.update({ siteId: site.siteId, enabled: false });
		expect((await contentClient(install, site.origin, null).get("/openapi.json")).status).toBe(404);
	});
});
