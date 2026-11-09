// What the Module SDK 1.4 adds, checked when the Install loads a Module: a Site route's limits, a
// Site script that runs before consent, and tables kept in monthly partitions; SDK 1.6's procedure
// kinds; and SDK 1.7's Dashboard Widgets. A definition that breaks a rule can't run; the Modules
// screen says why.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	type ModuleDefinition,
	type ModuleWidget,
	moduleSchema,
	siteColumns,
	text,
	uuid,
	widget,
} from "@webcraft/module-sdk";

import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { sampleBoard } from "./sample/board.ts";
import { sample } from "./sample/index.ts";

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall({ modules: [sample] });
});

afterAll(async () => {
	await install.close();
});

/** Why the Install can't run `module`, as the Modules screen says. */
async function problemOf(module: ModuleDefinition): Promise<string | null> {
	await install.restart({ modules: [module] });
	try {
		const { modules } = await (await install.superadmin()).api.modules.list();
		const found = modules.find((each) => each.id === "sample");
		expect(found?.status).toBe("cannot-run");
		return found?.problem ?? null;
	} finally {
		await install.restart({ modules: [sample] });
	}
}

const [route] = sample.siteRoutes ?? [];

/** A Widget kind that answers one number. */
const counter = widget({
	kind: "note-count",
	label: { en: "Notes", it: "Note" },
	description: { en: "How many notes.", it: "Quante note." },
	shape: "number",
	async query() {
		return { shape: "number", values: [{ key: "notes", label: { en: "Notes", it: "Note" }, count: 0 }] };
	},
});
const withWidgets = (widgets: readonly ModuleWidget[], more: Partial<ModuleDefinition> = {}): ModuleDefinition =>
	({ ...sample, manifest: { ...sample.manifest, sdk: "^1.7.0" }, widgets, ...more }) as ModuleDefinition;

describe("a Module's Widgets (SDK 1.7) can't run when", () => {
	test("a Workspace-level Module adds them: a Widget counts one Site at a time", async () => {
		await install.restart({ modules: [{ ...sampleBoard, widgets: [counter] } as ModuleDefinition] });
		try {
			const { modules } = await (await install.superadmin()).api.modules.list();
			expect(modules.find((each) => each.id === "sample-board")?.problem).toContain(
				"Only Site-level Modules add Widgets",
			);
		} finally {
			await install.restart({ modules: [sample] });
		}
	});

	test("a kind is named twice, or isn't lower-case words joined by dashes", async () => {
		expect(await problemOf(withWidgets([counter, counter]))).toContain("note-count is declared twice");
		expect(await problemOf(withWidgets([{ ...counter, kind: "NoteCount" }]))).toContain("isn't lower-case words");
	});

	test("its shape isn't one the admin draws, or its words miss a language", async () => {
		expect(await problemOf(withWidgets([{ ...counter, shape: "pie" as never }]))).toContain("shape pie isn't one of");
		expect(await problemOf(withWidgets([{ ...counter, label: { en: "Notes" } }]))).toContain("note-count's label");
	});

	test("it takes the Goal filter without saying which Goals there are", async () => {
		expect(await problemOf(withWidgets([{ ...counter, filters: ["goal"] }]))).toContain("has no widgetGoals");
		expect(await problemOf(withWidgets([{ ...counter, filters: ["weather" as never] }]))).toContain(
			"the filter weather",
		);
	});

	test("a setting starts with a value it doesn't offer, or has a default where options are worked out per Site", async () => {
		const options = [{ value: "open", label: { en: "Open", it: "Aperte" } }];
		const setting = { key: "state", label: { en: "State", it: "Stato" }, options };
		expect(await problemOf(withWidgets([{ ...counter, settings: [{ ...setting, default: "closed" }] }]))).toContain(
			"starts with a value it doesn't offer",
		);
		expect(
			await problemOf(
				withWidgets([{ ...counter, settings: [{ ...setting, options: async () => options, default: "open" }] }]),
			),
		).toContain("can't have a default");
	});
});

describe("a Module can't run when", () => {
	test("a procedure is neither a read nor a write", async () => {
		const { notes } = sample.procedures;
		const odd = {
			...sample,
			procedures: { ...sample.procedures, notes: { ...notes, list: { ...notes.list, kind: "maybe" } } },
		} as unknown as ModuleDefinition;
		expect(await problemOf(odd)).toContain("notes.list is neither a read nor a write");
	});

	test("a Site route's limit isn't whole requests per whole seconds", async () => {
		const limited = {
			...sample,
			siteRoutes: [{ ...route, limit: { requests: 0.5, perSeconds: 60 } }],
		} as ModuleDefinition;

		expect(await problemOf(limited)).toContain("limit isn't whole requests per whole seconds");
	});

	test("a Site route's largest body isn't a whole number of bytes", async () => {
		const sized = { ...sample, siteRoutes: [{ ...route, maxBodyBytes: -1 }] } as ModuleDefinition;

		expect(await problemOf(sized)).toContain("maxBodyBytes isn't a whole number of bytes");
	});

	test("its Necessary Site script says it runs before consent", async () => {
		const necessary: ModuleDefinition = {
			...sample,
			manifest: { ...sample.manifest, siteScript: "necessary" },
			siteScript: { code: "void 0;", beforeConsent: true },
		};

		expect(await problemOf(necessary)).toContain("beforeConsent says nothing");
	});

	test("it partitions a table that isn't its own, or by a column that isn't a time", async () => {
		const elsewhere = moduleSchema("sample").table("elsewhere", {
			...siteColumns(),
			id: uuid("id").notNull(),
			label: text("label").notNull(),
		});
		const label = { en: "Elsewhere", it: "Altrove" };

		expect(
			await problemOf({ ...sample, partitions: [{ table: elsewhere, column: elsewhere.label, label, keepMonths: 3 }] }),
		).toContain("isn't one of the Module's tables");
		expect(
			await problemOf({
				...sample,
				tables: [...(sample.tables ?? []), elsewhere],
				partitions: [{ table: elsewhere, column: elsewhere.label, label, keepMonths: 3 }],
			}),
		).toContain("which isn't a timestamp with time zone");
	});
});
