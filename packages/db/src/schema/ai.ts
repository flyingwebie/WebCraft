import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	foreignKey,
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";

import { people } from "./people.ts";
import { sites, workspaces } from "./tenancy.ts";

// AI keys, what they cost, and AI translation (ADR 0011): WebCraft calls AI providers directly with a
// Workspace's own AI key, or a shared Install key the Superadmin assigns to it, records the tokens and
// estimated cost of every call, and keeps monthly caps itself. Keys themselves are secrets, never here:
// a Workspace's own is its secret `ai.key`, a shared one the Install secret `ai.shared:<id>`.

/**
 * Shared Install keys: AI keys the Superadmin adds once and assigns to Workspaces, each Workspace
 * with a monthly cap of its own. Each has a provider (`openai`, `anthropic`, `google`, `openrouter`,
 * `openaiCompatible`), the model it calls, an endpoint for an OpenAI-compatible provider, and prices
 * (micro-dollars per million tokens; null: the built-in estimate for the model, or none).
 */
export const installAiKeys = pgTable("install_ai_keys", {
	id: uuid("id").primaryKey().defaultRandom(),
	name: text("name").notNull(),
	provider: text("provider").notNull(),
	model: text("model").notNull(),
	endpoint: text("endpoint"),
	inputPrice: bigint("input_price", { mode: "number" }),
	outputPrice: bigint("output_price", { mode: "number" }),
	createdBy: uuid("created_by").references(() => people.id, { onDelete: "set null" }),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	/** When a test call last went through, and what it answered (`ok` or the problem). */
	testedAt: timestamp("tested_at", { withTimezone: true }),
	testResult: text("test_result"),
});

/**
 * A Workspace's AI settings: its own AI key's provider, model, endpoint and prices (the key is the
 * Workspace secret `ai.key`), its optional monthly cap, and the shared Install key assigned to it
 * with its required monthly cap. The Workspace's own key wins; the shared key is used only without one.
 * Caps are in micro-dollars of estimated cost per calendar month (UTC).
 */
export const workspaceAi = pgTable(
	"workspace_ai",
	{
		workspaceId: uuid("workspace_id")
			.primaryKey()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		ownProvider: text("own_provider"),
		ownModel: text("own_model"),
		ownEndpoint: text("own_endpoint"),
		ownInputPrice: bigint("own_input_price", { mode: "number" }),
		ownOutputPrice: bigint("own_output_price", { mode: "number" }),
		ownCap: bigint("own_cap", { mode: "number" }),
		ownSetBy: uuid("own_set_by").references(() => people.id, { onDelete: "set null" }),
		ownSetAt: timestamp("own_set_at", { withTimezone: true }),
		ownTestedAt: timestamp("own_tested_at", { withTimezone: true }),
		ownTestResult: text("own_test_result"),
		sharedKeyId: uuid("shared_key_id").references(() => installAiKeys.id, { onDelete: "set null" }),
		sharedCap: bigint("shared_cap", { mode: "number" }),
	},
	(table) => [
		check("workspace_ai_shared_has_cap", sql`${table.sharedKeyId} is null or ${table.sharedCap} is not null`),
	],
);

/**
 * What a Workspace spends on one of its keys (`own` or `shared`) in one month (`2026-11`), counted so
 * two calls at once can't both pass the cap: a call reserves its estimated cost first (`reserved`),
 * with a conditional update that refuses when spent + reserved would pass the cap, then settles what it
 * really cost into `spent`. `notified` holds the notices sent this month: 80 and 100 (per cent).
 */
export const aiBudgets = pgTable(
	"ai_budgets",
	{
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		key: text("key").notNull(),
		month: text("month").notNull(),
		spent: bigint("spent", { mode: "number" }).notNull().default(0),
		reserved: bigint("reserved", { mode: "number" }).notNull().default(0),
		notified: integer("notified").array().notNull().default(sql`'{}'::integer[]`),
	},
	(table) => [primaryKey({ name: "ai_budgets_pkey", columns: [table.workspaceId, table.key, table.month] })],
);

/**
 * Every call to an AI provider: who paid (the Workspace, the key), for which Site (null for a key's
 * test), what for (`translation`, `altText`, `test`), the tokens the provider reported and the
 * estimated cost. A call is recorded `reserved` before it goes out and `done` or `failed` after; one
 * left `reserved` (its process stopped) gives its reservation back after 30 minutes.
 */
export const aiCalls = pgTable(
	"ai_calls",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		siteId: uuid("site_id"),
		key: text("key").notNull(),
		month: text("month").notNull(),
		provider: text("provider").notNull(),
		model: text("model").notNull(),
		purpose: text("purpose").notNull(),
		status: text("status").notNull(),
		reservedCost: bigint("reserved_cost", { mode: "number" }).notNull(),
		inputTokens: integer("input_tokens").notNull().default(0),
		outputTokens: integer("output_tokens").notNull().default(0),
		cost: bigint("cost", { mode: "number" }).notNull().default(0),
		at: timestamp("at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "ai_calls_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		index("ai_calls_workspace_month_idx").on(table.workspaceId, table.month),
		index("ai_calls_reserved_idx").on(table.status, table.at),
	],
);

/**
 * Protected terms: words AI translation leaves exactly as written. A Workspace's (no Site) apply to
 * all its Sites; a Site's to that Site only. `match_case` false matches any case, keeping the text as
 * it is written where it was found.
 */
export const protectedTerms = pgTable(
	"protected_terms",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		siteId: uuid("site_id"),
		term: text("term").notNull(),
		matchCase: boolean("match_case").notNull(),
		createdBy: uuid("created_by").references(() => people.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "protected_terms_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		unique("protected_terms_term_unique").on(table.workspaceId, table.siteId, table.term).nullsNotDistinct(),
	],
);

/**
 * A Site's translation cache: a piece of text already translated into a language, under one set of
 * Protected terms (`glossary`, a hash of the terms that applied), by the SHA-256 of the text sent.
 * Unchanged text is never sent twice.
 */
export const translationCache = pgTable(
	"translation_cache",
	{
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		language: text("language").notNull(),
		glossary: text("glossary").notNull(),
		sourceHash: text("source_hash").notNull(),
		translation: text("translation").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		primaryKey({
			name: "translation_cache_pkey",
			columns: [table.siteId, table.language, table.glossary, table.sourceHash],
		}),
		foreignKey({
			name: "translation_cache_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
	],
);

/**
 * AI translation waiting to be done for one item (an Entry, the Globals, a Form's emails) in one
 * language: `queued` until the worker takes it, `held` while it can't go on (no AI key, the monthly
 * cap reached) and comes back by itself, `failed` when the provider failed or refused (tried again by
 * Translate now or the item's next publish). `publish` is whether the translation goes live as it is
 * written (Automatic) or waits in the Draft (Review). The work runs as `requested_by`, with their
 * access as it is when it runs.
 */
export const translationTasks = pgTable(
	"translation_tasks",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		itemKind: text("item_kind").notNull(),
		itemId: uuid("item_id"),
		language: text("language").notNull(),
		publish: boolean("publish").notNull(),
		status: text("status").notNull(),
		reason: text("reason"),
		requestedBy: uuid("requested_by").references(() => people.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "translation_tasks_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		unique("translation_tasks_item_unique")
			.on(table.siteId, table.itemKind, table.itemId, table.language)
			.nullsNotDistinct(),
		index("translation_tasks_status_idx").on(table.status),
	],
);

/** How many pieces of text a Site's translations took from the cache and sent to a provider, per month. */
export const translationCounts = pgTable(
	"translation_counts",
	{
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		month: text("month").notNull(),
		cached: integer("cached").notNull().default(0),
		sent: integer("sent").notNull().default(0),
	},
	(table) => [
		primaryKey({ name: "translation_counts_pkey", columns: [table.siteId, table.month] }),
		foreignKey({
			name: "translation_counts_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
	],
);
