// The CLI's remote commands are generated from the public Management API (ADR 0030), as the MCP
// tools are: one command per public procedure, its words the operation id's in kebab-case (the same
// words as its MCP tool), Modules' procedures included under their id, internal procedures and
// Sensitive actions never commands. Checked through the help the CLI prints for each group, as a
// developer reads it, against the Install's own OpenAPI document.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FIRST_PARTY_MODULES } from "@webcraft/core";
import { toolName } from "@webcraft/mcp";

import { createApiToken } from "../harness/api-tokens.ts";
import { type CliUser, cliUser } from "../harness/cli.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";

type Operation = {
	operationId: string;
	summary: string;
	requestBody?: { content: Record<string, { schema: { properties?: Record<string, unknown>; required?: string[] } }> };
	"x-webcraft-sensitive"?: string;
};

let install: TestInstall;
let cli: CliUser;
let env: Record<string, string>;
let operations: Operation[];
/** Every command each group's help lists, with its summary. */
let listed: Map<string, string>;

beforeAll(async () => {
	install = await createTestInstall({ modules: FIRST_PARTY_MODULES });
	const document = (await (await install.request(install.adminUrl("/api/v1/openapi.json"))).json()) as {
		paths: Record<string, Record<string, Operation>>;
	};
	operations = Object.values(document.paths).flatMap((methods) => Object.values(methods));
	const { id: workspaceId } = await install.createWorkspace();
	const { secret } = await createApiToken(await install.superadmin(), { workspaceId, name: "Generation" });
	env = { WEBCRAFT_TOKEN: secret, WEBCRAFT_INSTALL: install.adminUrl("/") };
	cli = cliUser(install);
	listed = new Map();
	const groups = (await cli.run(["help", "commands"], { env })).stdout
		.split("\n")
		.map((line) => /^ {2}(\S+)\s+\d+ commands?$/.exec(line)?.[1])
		.filter((group): group is string => Boolean(group));
	for (const group of groups) {
		const { stdout } = await cli.run([group, "--help"], { env });
		for (const line of stdout.split("\n")) {
			const match = /^ {2}(\S+(?: \S+)*?) {2,}(.+) \[(?:reads|changes)/.exec(line);
			if (match?.[1] && match[2]) listed.set(match[1], match[2]);
		}
	}
});

afterAll(async () => {
	await cli.close();
	await install.close();
});

/** A command's words for an operation id, as a developer types them. */
function words(operationId: string): string {
	const parts = operationId.split(".");
	return (parts[0] === "m" ? parts.slice(1) : parts)
		.map((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase())
		.join(" ");
}

describe("commands", () => {
	test("every public procedure but the Sensitive ones is a command, with its summary", () => {
		const expected = operations.filter((operation) => !operation["x-webcraft-sensitive"]);
		expect(expected.length).toBeGreaterThan(200);
		for (const operation of expected) {
			expect({ operation: operation.operationId, summary: listed.get(words(operation.operationId)) }).toEqual({
				operation: operation.operationId,
				summary: operation.summary,
			});
		}
		expect(listed.size).toBe(expected.length);
	});

	test("a command's words are its MCP tool's, so scripts and AI clients speak of the same thing", () => {
		for (const operation of operations) {
			expect(words(operation.operationId).replaceAll(/[ -]/g, "_")).toBe(toolName(operation.operationId));
		}
	});

	test("Modules' procedures are commands under the Module's id", () => {
		expect(listed.get("redirects rules list")).toBeDefined();
		expect(listed.get("site-analytics stats totals")).toBeDefined();
		expect(listed.get("forms submissions list")).toBeDefined();
	});

	test("Sensitive actions and internal procedures never are", async () => {
		const sensitive = operations.filter((operation) => operation["x-webcraft-sensitive"]);
		expect(sensitive.length).toBeGreaterThan(5);
		for (const operation of sensitive) expect(listed.has(words(operation.operationId))).toBe(false);

		expect((await cli.run(["staging", "set-password", "--site-id", crypto.randomUUID()], { env })).code).toBe(7);
		const internal = await cli.run(["api-tokens", "create"], { env });
		expect(internal.code).toBe(2);
		expect(internal.stderr).toContain("There is no command webcraft api-tokens create");
	});

	test("a command's options are its procedure's input, the required ones said so", async () => {
		for (const operationId of ["entries.saveDraft", "media.list", "templates.saveEntryTemplateMarkup"]) {
			const operation = operations.find((each) => each.operationId === operationId);
			const schema = operation?.requestBody?.content["application/json"]?.schema;
			const { stdout } = await cli.run([...words(operationId).split(" "), "--help"], { env });
			for (const property of Object.keys(schema?.properties ?? {})) {
				const option = `--${property.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}`;
				expect({ operationId, option, listed: stdout.includes(option) }).toEqual({ operationId, option, listed: true });
			}
			for (const property of schema?.required ?? []) {
				const option = `--${property.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}`;
				expect(stdout).toMatch(new RegExp(`${option} \\S+\\s+required`));
			}
		}
	});
});
