// A request without a file has a ceiling of WebCraft's own (audit A4, "Sloppy code"): only multipart
// bodies were held to a limit, so a JSON body was bounded by nothing but the runtime's default. The
// admin's API (`/api/rpc`) and the public one (`/api/v1`) both refuse a larger one before reading it,
// and stop reading one that doesn't say its length.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { API_BODY_MAX_BYTES } from "@webcraft/api";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import { API_PATH, createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

const MB = 1024 * 1024;

let install: TestInstall;
let admin: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	workspaceId = (await install.createWorkspace()).id;
});

afterAll(async () => {
	await install.close();
});

/** A body of spaces twice the ceiling, a megabyte at a time, and how much of it was asked for. */
function oversized() {
	const state = { pulled: 0 };
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (state.pulled >= 2 * API_BODY_MAX_BYTES) return controller.close();
			state.pulled += MB;
			controller.enqueue(new Uint8Array(MB).fill(32));
		},
	});
	return { body, state };
}

const TOO_LARGE = { json: { code: "PAYLOAD_TOO_LARGE", status: 413, data: { maxBytes: API_BODY_MAX_BYTES } } };

describe("a request without a file", () => {
	test("declaring more than the ceiling is refused before its body is read", async () => {
		const { body, state } = oversized();

		const response = await admin.request(install.adminUrl(`${API_PATH}/sites/list`), {
			method: "POST",
			headers: { "content-type": "application/json", "content-length": String(API_BODY_MAX_BYTES + 1) },
			body,
			// @ts-expect-error: Bun takes a streamed body without `duplex`, browsers need it.
			duplex: "half",
		});

		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject(TOO_LARGE);
		expect(state.pulled).toBeLessThanOrEqual(2 * MB);
	});

	test("that doesn't say its length stops being read once it passes the ceiling", async () => {
		const { body, state } = oversized();

		const response = await admin.request(install.adminUrl(`${API_PATH}/sites/list`), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
			// @ts-expect-error: Bun takes a streamed body without `duplex`, browsers need it.
			duplex: "half",
		});

		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject(TOO_LARGE);
		// A few megabytes are read ahead; the rest of the body never is.
		expect(state.pulled).toBeLessThanOrEqual(API_BODY_MAX_BYTES + 8 * MB);
	});

	test("is held to the same ceiling on the public API", async () => {
		const { secret } = await createApiToken(admin, { workspaceId, name: "Script" });
		const { body, state } = oversized();

		const response = await tokenClient(install, secret).request("sites/list", {
			headers: { "content-type": "application/json", "content-length": String(API_BODY_MAX_BYTES + 1) },
			body,
			// @ts-expect-error: Bun takes a streamed body without `duplex`, browsers need it.
			duplex: "half",
		});

		expect(response.status).toBe(413);
		expect(state.pulled).toBeLessThanOrEqual(2 * MB);
	});

	test("as large as any procedure's input gets is still taken", async () => {
		// The largest input a procedure takes is a string of 8 million characters: sent here to a
		// procedure that has no such field, it is read whole and answered as bad input, not as too large.
		const response = await admin.request(install.adminUrl(`${API_PATH}/sites/list`), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ json: { workspaceId, padding: "é".repeat(8_000_000) } }),
		});

		expect(response.status).not.toBe(413);
	});
});
