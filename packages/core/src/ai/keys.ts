import { isIP } from "node:net";

import type { Database } from "@webcraft/db";
import { aiBudgets, aiCalls, installAiKeys, people, sites, workspaceAi, workspaces } from "@webcraft/db/schema";
import { and, asc, eq, lt, sql } from "drizzle-orm";

import type { Clock } from "../clock.ts";
import type { Email } from "../email/index.ts";
import { isPublicAddress } from "../guarded-fetch.ts";
import { readSettingsRow, writeSettingsRow } from "../install-settings.ts";
import type { Logger } from "../log.ts";
import { actingPerson } from "../permissions/can.ts";
import type { SecretDescription, Secrets } from "../secrets/store.ts";
import type { Executor, InstallScope, WorkspaceScope } from "../tenancy/data-layer.ts";
import { WorkspaceNotFoundError } from "../tenancy/errors.ts";
import { siteStaff, workspaceOwners } from "../tenancy/site-owners.ts";
import { AiCapReachedError, AiKeyInvalidError, SharedAiKeyNotFoundError } from "./errors.ts";
import {
	AI_CAP_MAX,
	AI_KEY_LIMITS,
	type AiPrice,
	type AiProvider,
	fromMicros,
	isAiProvider,
	knownAiPrice,
	toMicros,
} from "./models.ts";
import {
	type AiConnection,
	AiKeyMissingError,
	AiProviderError,
	type AiProviderProblem,
	type AiProviders,
	type AiUsage,
	sharedAiKeySecret,
	WORKSPACE_AI_KEY,
} from "./providers.ts";

/**
 * AI keys and what they cost (ADR 0011). A Workspace's own key (Owner or Staff, `aiKey.manage`) or the
 * shared Install key the Superadmin assigned to it: the own key wins. Every call to a provider goes
 * through `call`, which picks the key, reserves the call's estimated cost against the key's monthly
 * cap (so two calls at once can't both pass it), fills the key in for that call only, and records the
 * tokens and estimated cost per Workspace and Site. At 80% of a cap the Workspace's Owners and Staff
 * get the `ai-key-cap` email; at 100% calls stop until the cap is raised or the month ends.
 */

/** What a call is for: AI translation, Suggest alt text, or a key's Test. */
export type AiPurpose = "translation" | "altText" | "report" | "test";

/** Which of a Workspace's keys: its own, or the shared key assigned to it. */
export type AiKeyKind = "own" | "shared";

/** A key's price as people see it: dollars per million tokens, and whether it is WebCraft's estimate. */
export type AiPriceView = AiPrice & { estimated: boolean };

export type OwnAiKeyView = {
	provider: AiProvider;
	model: string;
	endpoint: string | null;
	key: SecretDescription;
	/** Null: no price is known for the model, so its calls cost nothing as far as WebCraft can tell. */
	price: AiPriceView | null;
	/** Dollars a month; null for no cap. */
	monthlyCap: number | null;
	setBy: { id: string; name: string } | null;
	setAt: Date | null;
	testedAt: Date | null;
	/** What the last Test said: `ok`, or the problem. */
	testResult: string | null;
};

/** The shared key assigned to a Workspace, as its Owners see it: never the key, nor its last characters. */
export type AssignedAiKeyView = { name: string; provider: AiProvider; model: string; monthlyCap: number };

/** One key's spending this month: dollars spent, its cap, the share used, and whether calls stopped. */
export type AiBudgetView = { spent: number; cap: number | null; percent: number | null; stopped: boolean };

/** What one Site spent on AI this month. */
export type AiSiteUsage = {
	siteId: string;
	name: string;
	calls: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	/** The keys its calls went through. */
	keys: AiKeyKind[];
};

export type WorkspaceAiView = {
	own: OwnAiKeyView | null;
	shared: AssignedAiKeyView | null;
	/** The key calls go through now: the own key wins. */
	inUse: AiKeyKind | null;
	/** This month (`2026-11`, UTC): spending against each key's cap, and per Site. */
	usage: { month: string; own: AiBudgetView | null; shared: AiBudgetView | null; sites: AiSiteUsage[] };
};

export type OwnAiKeyInput = {
	provider: AiProvider;
	model: string;
	endpoint: string | null;
	/** The key itself: needed the first time, and whenever the provider or endpoint changes. */
	key?: string;
	/** Dollars per million tokens; WebCraft's estimate for the model when absent. */
	price?: AiPrice | null;
	/** Dollars a month; absent: unchanged (none for a new key). */
	monthlyCap?: number | null;
};

export type SharedAiKeyInput = {
	name: string;
	provider: AiProvider;
	model: string;
	endpoint: string | null;
	key?: string;
	price?: AiPrice | null;
};

export type SharedAiKeyView = {
	id: string;
	name: string;
	provider: AiProvider;
	model: string;
	endpoint: string | null;
	key: SecretDescription;
	price: AiPriceView | null;
	createdAt: Date;
	testedAt: Date | null;
	testResult: string | null;
	/** The Workspaces it is assigned to, each with its cap and this month's spending on it. */
	workspaces: { id: string; name: string; monthlyCap: number; spent: number }[];
};

export type SharedAiKeys = {
	keys: SharedAiKeyView[];
	/** Whether a shared key may call an endpoint inside the Install's network. */
	privateEndpoints: boolean;
	/** Every Workspace, with the shared key assigned to it, for the Superadmin to assign. */
	workspaces: { id: string; name: string; keyId: string | null; monthlyCap: number | null }[];
};

/** The answer of a key's Test. */
export type AiKeyTest = { ok: boolean; problem: AiProviderProblem | "cap" | null };

/** Where a call is made: a Workspace, and the Site it is for (none for a key's Test). */
export type AiPlace = { workspaceId: string; siteId: string | null };

export type AiKeys = {
	view(scope: WorkspaceScope): Promise<WorkspaceAiView>;
	setOwn(scope: WorkspaceScope, input: OwnAiKeyInput): Promise<void>;
	removeOwn(scope: WorkspaceScope): Promise<void>;
	setOwnCap(scope: WorkspaceScope, monthlyCap: number | null): Promise<void>;
	testOwn(scope: WorkspaceScope): Promise<AiKeyTest>;
	shared: {
		list(scope: InstallScope): Promise<SharedAiKeys>;
		add(scope: InstallScope, input: SharedAiKeyInput): Promise<SharedAiKeyView>;
		update(scope: InstallScope, keyId: string, input: SharedAiKeyInput): Promise<SharedAiKeyView>;
		remove(scope: InstallScope, keyId: string): Promise<void>;
		test(scope: InstallScope, keyId: string): Promise<AiKeyTest>;
		assign(scope: InstallScope, workspaceId: string, keyId: string | null, monthlyCap: number | null): Promise<void>;
		setPrivateEndpoints(scope: InstallScope, on: boolean): Promise<void>;
	};
	/**
	 * Whether the Workspace has a key in use, whether its cap still lets calls start this month, and
	 * the share of the cap used (null without a cap).
	 */
	readiness(workspaceId: string): Promise<{ key: AiKeyKind | null; capReached: boolean; percent: number | null }>;
	/**
	 * Calls a provider for a Workspace (and Site) with the key it uses now. `estimate` is the most the
	 * call is expected to use; it is reserved against the cap first. Throws `AiKeyMissingError`
	 * without a key, `AiCapReachedError` when the cap is reached, and whatever `run` throws.
	 */
	call<Value>(
		place: AiPlace,
		purpose: AiPurpose,
		estimate: AiUsage,
		run: (connection: AiConnection) => Promise<{ value: Value; usage?: AiUsage }>,
	): Promise<Value>;
	/** Gives back the reservations of calls whose process stopped half-way (older than 30 minutes). */
	releaseStale(): Promise<number>;
	/** Runs after a Workspace's keys or caps change: AI translation picks up work that waited. */
	onChange(listener: (workspaceId: string) => Promise<void>): void;
};

export type AiKeysOptions = {
	database: Database;
	secrets: Secrets;
	clock: Clock;
	log: Logger;
	email: Email;
	ai: AiProviders;
};

/** A key's settings, read from its row: where calls go, what they cost and the cap. */
type KeyInUse = {
	kind: AiKeyKind;
	provider: AiProvider;
	model: string;
	endpoint: string | null;
	/** Micro-dollars per million tokens; null: unknown. */
	price: { input: number; output: number } | null;
	/** Micro-dollars a month; null: no cap. */
	cap: number | null;
	secret: { owner: { kind: "workspace"; workspaceId: string } | { kind: "install" }; name: string };
	privateNetwork: boolean;
};

/** A reservation left behind longer than this gives its cost back. */
const STALE_RESERVATION_MS = 30 * 60 * 1000;

/** The month a time falls in, as budgets count it: `2026-11` (UTC). */
export function monthOf(at: Date): string {
	return at.toISOString().slice(0, 7);
}

/** When a month's budget ends: the first instant of the next month (UTC). */
export function monthEnd(at: Date): Date {
	return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

/** What a call costs in micro-dollars, at a price in micro-dollars per million tokens. */
export function costOf(usage: AiUsage, price: { input: number; output: number } | null): number {
	if (!price) return 0;
	return Math.ceil((usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000);
}

export function createAiKeys(options: AiKeysOptions): AiKeys {
	const { database, secrets, clock, log, email, ai } = options;
	const listeners: ((workspaceId: string) => Promise<void>)[] = [];
	const changed = async (workspaceId: string) => {
		for (const listener of listeners) {
			try {
				await listener(workspaceId);
			} catch (error) {
				log.error("Work waiting for an AI key couldn't be picked up", { workspaceId, error });
			}
		}
	};

	const settingsOf = async (executor: Executor, workspaceId: string) => {
		const [row] = await executor.select().from(workspaceAi).where(eq(workspaceAi.workspaceId, workspaceId));
		return row ?? null;
	};

	const ownSecret = (workspaceId: string) => ({
		owner: { kind: "workspace" as const, workspaceId },
		name: WORKSPACE_AI_KEY,
	});

	/** The key a Workspace's calls go through now: its own when set, else the shared one assigned to it. */
	const keyInUse = async (executor: Executor, workspaceId: string): Promise<KeyInUse | null> => {
		const row = await settingsOf(executor, workspaceId);
		if (row?.ownProvider && row.ownModel && isAiProvider(row.ownProvider)) {
			if ((await secrets.describe(ownSecret(workspaceId))).set) {
				return {
					kind: "own",
					provider: row.ownProvider,
					model: row.ownModel,
					endpoint: row.ownEndpoint,
					price: priceMicros(row.ownProvider, row.ownModel, row.ownInputPrice, row.ownOutputPrice),
					cap: row.ownCap,
					secret: ownSecret(workspaceId),
					privateNetwork: false,
				};
			}
		}
		if (row?.sharedKeyId) {
			const [key] = await executor.select().from(installAiKeys).where(eq(installAiKeys.id, row.sharedKeyId));
			if (key && isAiProvider(key.provider)) {
				const settings = await readSettingsRow(executor);
				return {
					kind: "shared",
					provider: key.provider,
					model: key.model,
					endpoint: key.endpoint,
					price: priceMicros(key.provider, key.model, key.inputPrice, key.outputPrice),
					cap: row.sharedCap,
					secret: { owner: { kind: "install" }, name: sharedAiKeySecret(key.id) },
					privateNetwork: settings?.aiPrivateEndpoints ?? false,
				};
			}
		}
		return null;
	};

	const budgetOf = async (executor: Executor, workspaceId: string, kind: AiKeyKind, month: string) => {
		const [row] = await executor
			.select()
			.from(aiBudgets)
			.where(and(eq(aiBudgets.workspaceId, workspaceId), eq(aiBudgets.key, kind), eq(aiBudgets.month, month)));
		return row ?? { spent: 0, reserved: 0, notified: [] as number[] };
	};

	/**
	 * Reserves `amount` against the key's cap this month, in one conditional update: refused when what
	 * is spent and reserved already reaches the cap. Two calls at once each see the other's
	 * reservation, so they can't both pass it.
	 */
	const reserve = async (
		executor: Executor,
		workspaceId: string,
		kind: AiKeyKind,
		month: string,
		amount: number,
		cap: number | null,
	): Promise<boolean> => {
		await executor.insert(aiBudgets).values({ workspaceId, key: kind, month }).onConflictDoNothing();
		// Room left is enough to start: a call may pass the cap by what it costs over its estimate, never
		// more, and a call started while another one's reservation fills the cap is refused.
		const within = cap === null ? sql`true` : sql`${aiBudgets.spent} + ${aiBudgets.reserved} < ${cap}`;
		const reserved = await executor
			.update(aiBudgets)
			.set({ reserved: sql`${aiBudgets.reserved} + ${amount}` })
			.where(and(eq(aiBudgets.workspaceId, workspaceId), eq(aiBudgets.key, kind), eq(aiBudgets.month, month), within))
			.returning({ spent: aiBudgets.spent });
		return reserved.length > 0;
	};

	/** Turns a call's reservation into what it cost, and records its tokens. */
	const settle = async (
		callId: string,
		place: { workspaceId: string; kind: AiKeyKind; month: string },
		reserved: number,
		outcome: { status: "done" | "failed"; usage: AiUsage; cost: number },
	) => {
		await database.db.transaction(async (tx) => {
			await tx
				.update(aiCalls)
				.set({
					status: outcome.status,
					inputTokens: outcome.usage.inputTokens,
					outputTokens: outcome.usage.outputTokens,
					cost: outcome.cost,
				})
				.where(eq(aiCalls.id, callId));
			await tx
				.update(aiBudgets)
				.set({
					reserved: sql`greatest(${aiBudgets.reserved} - ${reserved}, 0)`,
					spent: sql`${aiBudgets.spent} + ${outcome.cost}`,
				})
				.where(
					and(
						eq(aiBudgets.workspaceId, place.workspaceId),
						eq(aiBudgets.key, place.kind),
						eq(aiBudgets.month, place.month),
					),
				);
		});
	};

	/**
	 * Sends the `ai-key-cap` email at `percent` of a cap, once a month: whoever marks it first in the
	 * budget's row sends it, so two calls finishing together send one email.
	 */
	const notify = async (workspaceId: string, kind: AiKeyKind, month: string, percent: 80 | 100) => {
		const marked = await database.db
			.update(aiBudgets)
			.set({ notified: sql`array_append(${aiBudgets.notified}, ${percent})` })
			.where(
				and(
					eq(aiBudgets.workspaceId, workspaceId),
					eq(aiBudgets.key, kind),
					eq(aiBudgets.month, month),
					sql`not (${percent} = any(${aiBudgets.notified}))`,
				),
			)
			.returning({ workspaceId: aiBudgets.workspaceId });
		if (marked.length === 0) return;
		const [workspace] = await database.db
			.select({ id: workspaces.id, name: workspaces.name })
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId));
		if (!workspace) return;
		const scope = { db: database.db, workspace };
		const recipients = [...new Set([...(await workspaceOwners(scope)), ...(await siteStaff(scope))])];
		if (recipients.length === 0) return;
		try {
			await email.send({
				type: "ai-key-cap",
				to: recipients.map((personId) => ({ personId })),
				data: { workspaceName: workspace.name, percent, usagePath: `/workspaces/${workspaceId}/ai-keys` },
			});
		} catch (error) {
			log.error("The AI cap email couldn't be queued", { workspaceId, percent, error });
		}
	};

	/** After spending: the notices a budget passed (80% and 100%). */
	const noticesAfter = async (workspaceId: string, kind: AiKeyKind, month: string, cap: number | null) => {
		if (cap === null || cap <= 0) return;
		const budget = await budgetOf(database.db, workspaceId, kind, month);
		if (budget.spent >= cap) await notify(workspaceId, kind, month, 100);
		if (budget.spent >= (cap * 80) / 100) await notify(workspaceId, kind, month, 80);
	};

	const call: AiKeys["call"] = async (place, purpose, estimate, run) => {
		const key = await keyInUse(database.db, place.workspaceId);
		if (!key) throw new AiKeyMissingError();
		const now = clock.now();
		const month = monthOf(now);
		const reservedCost = costOf(estimate, key.price);
		const callId = await database.db.transaction(async (tx) => {
			if (!(await reserve(tx, place.workspaceId, key.kind, month, reservedCost, key.cap))) return null;
			const [row] = await tx
				.insert(aiCalls)
				.values({
					workspaceId: place.workspaceId,
					siteId: place.siteId,
					key: key.kind,
					month,
					provider: key.provider,
					model: key.model,
					purpose,
					status: "reserved",
					reservedCost,
					at: now,
				})
				.returning({ id: aiCalls.id });
			return row?.id ?? null;
		});
		if (!callId) {
			await notify(place.workspaceId, key.kind, month, 100);
			throw new AiCapReachedError(key.kind, monthEnd(now));
		}
		const where = { workspaceId: place.workspaceId, kind: key.kind, month };
		let answer: { value: unknown; usage?: AiUsage };
		try {
			answer = await secrets.useWith(key.secret, (value) =>
				run({
					provider: key.provider,
					model: key.model,
					endpoint: key.endpoint,
					key: value,
					privateNetwork: key.privateNetwork,
				}),
			);
		} catch (error) {
			// A failed call still used what the provider reports; it rarely reports anything, so it costs nothing here.
			await settle(callId, where, reservedCost, {
				status: "failed",
				usage: { inputTokens: 0, outputTokens: 0 },
				cost: 0,
			});
			throw error;
		}
		const usage = answer.usage ?? { inputTokens: 0, outputTokens: 0 };
		await settle(callId, where, reservedCost, { status: "done", usage, cost: costOf(usage, key.price) });
		await noticesAfter(place.workspaceId, key.kind, month, key.cap);
		return answer.value as never;
	};

	const testWith = async (place: AiPlace, check: () => Promise<KeyInUse | null>): Promise<AiKeyTest> => {
		if (!(await check())) return { ok: false, problem: "refused" };
		try {
			await call(place, "test", { inputTokens: 200, outputTokens: 200 }, async (connection) => {
				const answer = await ai.translate({
					connection,
					purpose: "test",
					from: { code: "en", name: "English" },
					to: { code: "fr", name: "Français" },
					texts: ["Hello"],
				});
				return { value: answer.texts, usage: answer.usage };
			});
			return { ok: true, problem: null };
		} catch (error) {
			if (error instanceof AiCapReachedError) return { ok: false, problem: "cap" };
			if (error instanceof AiProviderError) return { ok: false, problem: error.problem };
			if (error instanceof AiKeyMissingError) return { ok: false, problem: "refused" };
			throw error;
		}
	};

	const usageView = async (executor: Executor, workspaceId: string): Promise<WorkspaceAiView["usage"]> => {
		const month = monthOf(clock.now());
		const settings = await settingsOf(executor, workspaceId);
		const budget = async (kind: AiKeyKind, cap: number | null, present: boolean): Promise<AiBudgetView | null> => {
			if (!present) return null;
			const row = await budgetOf(executor, workspaceId, kind, month);
			return {
				spent: fromMicros(row.spent),
				cap: cap === null ? null : fromMicros(cap),
				percent: cap === null || cap <= 0 ? null : Math.floor((row.spent / cap) * 100),
				stopped: cap !== null && row.spent >= cap,
			};
		};
		const rows = await executor
			.select({
				siteId: aiCalls.siteId,
				name: sites.name,
				key: aiCalls.key,
				calls: sql<number>`count(*)::int`,
				inputTokens: sql<number>`coalesce(sum(${aiCalls.inputTokens}), 0)::int`,
				outputTokens: sql<number>`coalesce(sum(${aiCalls.outputTokens}), 0)::int`,
				cost: sql<number>`coalesce(sum(${aiCalls.cost}), 0)::bigint`,
			})
			.from(aiCalls)
			.innerJoin(sites, eq(sites.id, aiCalls.siteId))
			.where(and(eq(aiCalls.workspaceId, workspaceId), eq(aiCalls.month, month), eq(aiCalls.status, "done")))
			.groupBy(aiCalls.siteId, sites.name, aiCalls.key)
			.orderBy(asc(sites.name));
		const bySite = new Map<string, AiSiteUsage>();
		for (const row of rows) {
			if (!row.siteId) continue;
			const site = bySite.get(row.siteId) ?? {
				siteId: row.siteId,
				name: row.name,
				calls: 0,
				inputTokens: 0,
				outputTokens: 0,
				cost: 0,
				keys: [],
			};
			site.calls += row.calls;
			site.inputTokens += row.inputTokens;
			site.outputTokens += row.outputTokens;
			site.cost += fromMicros(Number(row.cost));
			if (row.key === "own" || row.key === "shared") site.keys.push(row.key);
			bySite.set(row.siteId, site);
		}
		return {
			month,
			own: await budget("own", settings?.ownCap ?? null, Boolean(settings?.ownProvider)),
			shared: await budget("shared", settings?.sharedCap ?? null, Boolean(settings?.sharedKeyId)),
			sites: [...bySite.values()],
		};
	};

	const sharedView = async (executor: Executor, row: typeof installAiKeys.$inferSelect): Promise<SharedAiKeyView> => {
		const month = monthOf(clock.now());
		const assigned = await executor
			.select({
				id: workspaces.id,
				name: workspaces.name,
				monthlyCap: workspaceAi.sharedCap,
				spent: sql<number>`coalesce((select ${aiBudgets.spent} from ${aiBudgets} where ${aiBudgets.workspaceId} = ${workspaces.id} and ${aiBudgets.key} = 'shared' and ${aiBudgets.month} = ${month}), 0)::bigint`,
			})
			.from(workspaceAi)
			.innerJoin(workspaces, eq(workspaces.id, workspaceAi.workspaceId))
			.where(eq(workspaceAi.sharedKeyId, row.id))
			.orderBy(asc(workspaces.name));
		const provider = isAiProvider(row.provider) ? row.provider : "openaiCompatible";
		return {
			id: row.id,
			name: row.name,
			provider,
			model: row.model,
			endpoint: row.endpoint,
			key: await secrets.describe({ owner: { kind: "install" }, name: sharedAiKeySecret(row.id) }),
			price: priceView(provider, row.model, row.inputPrice, row.outputPrice),
			createdAt: row.createdAt,
			testedAt: row.testedAt,
			testResult: row.testResult,
			workspaces: assigned.map((workspace) => ({
				id: workspace.id,
				name: workspace.name,
				monthlyCap: fromMicros(workspace.monthlyCap ?? 0),
				spent: fromMicros(Number(workspace.spent)),
			})),
		};
	};

	const findShared = async (executor: Executor, keyId: string) => {
		const [row] = /^[0-9a-f-]{36}$/i.test(keyId)
			? await executor.select().from(installAiKeys).where(eq(installAiKeys.id, keyId))
			: [];
		if (!row) throw new SharedAiKeyNotFoundError();
		return row;
	};

	const upsertSettings = async (
		executor: Executor,
		workspaceId: string,
		values: Partial<typeof workspaceAi.$inferInsert>,
	) => {
		await executor
			.insert(workspaceAi)
			.values({ workspaceId, ...values })
			.onConflictDoUpdate({ target: workspaceAi.workspaceId, set: values });
	};

	return {
		async view(scope) {
			const row = await settingsOf(scope.db, scope.workspace.id);
			let own: OwnAiKeyView | null = null;
			const description = await scope.secrets.describe(WORKSPACE_AI_KEY);
			if (row?.ownProvider && row.ownModel && isAiProvider(row.ownProvider) && description.set) {
				const [setter] = row.ownSetBy
					? await scope.db.select({ id: people.id, name: people.name }).from(people).where(eq(people.id, row.ownSetBy))
					: [];
				own = {
					provider: row.ownProvider,
					model: row.ownModel,
					endpoint: row.ownEndpoint,
					key: description,
					price: priceView(row.ownProvider, row.ownModel, row.ownInputPrice, row.ownOutputPrice),
					monthlyCap: row.ownCap === null ? null : fromMicros(row.ownCap),
					setBy: setter ?? null,
					setAt: row.ownSetAt,
					testedAt: row.ownTestedAt,
					testResult: row.ownTestResult,
				};
			}
			let shared: AssignedAiKeyView | null = null;
			if (row?.sharedKeyId && row.sharedCap !== null) {
				const [key] = await scope.db.select().from(installAiKeys).where(eq(installAiKeys.id, row.sharedKeyId));
				if (key && isAiProvider(key.provider)) {
					shared = { name: key.name, provider: key.provider, model: key.model, monthlyCap: fromMicros(row.sharedCap) };
				}
			}
			return {
				own,
				shared,
				inUse: own ? "own" : shared ? "shared" : null,
				usage: await usageView(scope.db, scope.workspace.id),
			};
		},

		async setOwn(scope, input) {
			const workspaceId = scope.workspace.id;
			const row = await settingsOf(scope.db, workspaceId);
			const hadKey = (await scope.secrets.describe(WORKSPACE_AI_KEY)).set && Boolean(row?.ownProvider);
			const endpoint = checkEndpoint(input.provider, input.endpoint, false);
			const model = checkModel(input.model);
			const key = input.key === undefined ? undefined : checkKey(input.key);
			const moved = !hadKey || row?.ownProvider !== input.provider || (row?.ownEndpoint ?? null) !== endpoint;
			// A stored key is only ever sent where it was saved for: moving it needs the key again.
			if (moved && key === undefined) throw new AiKeyInvalidError("key", "needed");
			const price = input.price === undefined ? null : checkPrice(input.price);
			const cap =
				input.monthlyCap === undefined ? (hadKey ? (row?.ownCap ?? null) : null) : checkCap(input.monthlyCap, false);
			if (cap !== null && !price && !knownAiPrice(input.provider, model))
				throw new AiKeyInvalidError("price", "needed");
			await scope.transaction(async (tx) => {
				await upsertSettings(tx.db, workspaceId, {
					ownProvider: input.provider,
					ownModel: model,
					ownEndpoint: endpoint,
					ownInputPrice: price ? toMicros(price.input) : null,
					ownOutputPrice: price ? toMicros(price.output) : null,
					ownCap: cap,
					...(key === undefined
						? {}
						: { ownSetBy: actingPerson(tx.access.actor), ownSetAt: tx.now(), ownTestedAt: null, ownTestResult: null }),
				});
				await tx.audit("aiKey.set", {
					provider: input.provider,
					model,
					...(endpoint ? { endpoint: new URL(endpoint).host } : {}),
					keyChanged: key !== undefined,
				});
			});
			if (key !== undefined) await scope.secrets.set(WORKSPACE_AI_KEY, key);
			await changed(workspaceId);
		},

		async removeOwn(scope) {
			await scope.transaction(async (tx) => {
				await upsertSettings(tx.db, scope.workspace.id, {
					ownProvider: null,
					ownModel: null,
					ownEndpoint: null,
					ownInputPrice: null,
					ownOutputPrice: null,
					ownCap: null,
					ownSetBy: null,
					ownSetAt: null,
					ownTestedAt: null,
					ownTestResult: null,
				});
				await tx.audit("aiKey.remove", {});
			});
			await scope.secrets.remove(WORKSPACE_AI_KEY);
			await changed(scope.workspace.id);
		},

		async setOwnCap(scope, monthlyCap) {
			const row = await settingsOf(scope.db, scope.workspace.id);
			if (!row?.ownProvider || !row.ownModel || !isAiProvider(row.ownProvider)) throw new AiKeyMissingError();
			const cap = checkCap(monthlyCap, false);
			if (cap !== null && !priceMicros(row.ownProvider, row.ownModel, row.ownInputPrice, row.ownOutputPrice)) {
				throw new AiKeyInvalidError("price", "needed");
			}
			await scope.transaction(async (tx) => {
				await upsertSettings(tx.db, scope.workspace.id, { ownCap: cap });
				await tx.audit("aiKey.changeCap", { monthlyCap });
			});
			await changed(scope.workspace.id);
		},

		async testOwn(scope) {
			const result = await testWith({ workspaceId: scope.workspace.id, siteId: null }, async () => {
				const key = await keyInUse(scope.db, scope.workspace.id);
				return key?.kind === "own" ? key : null;
			});
			await upsertSettings(database.db, scope.workspace.id, {
				ownTestedAt: clock.now(),
				ownTestResult: result.ok ? "ok" : result.problem,
			});
			return result;
		},

		shared: {
			async list(scope) {
				const rows = await scope.db.select().from(installAiKeys).orderBy(asc(installAiKeys.name));
				const all = await scope.db
					.select({
						id: workspaces.id,
						name: workspaces.name,
						keyId: workspaceAi.sharedKeyId,
						cap: workspaceAi.sharedCap,
					})
					.from(workspaces)
					.leftJoin(workspaceAi, eq(workspaceAi.workspaceId, workspaces.id))
					.orderBy(asc(workspaces.name));
				return {
					keys: await Promise.all(rows.map((row) => sharedView(scope.db, row))),
					privateEndpoints: (await readSettingsRow(scope.db))?.aiPrivateEndpoints ?? false,
					workspaces: all.map((workspace) => ({
						id: workspace.id,
						name: workspace.name,
						keyId: workspace.keyId ?? null,
						monthlyCap: workspace.keyId && workspace.cap !== null ? fromMicros(workspace.cap) : null,
					})),
				};
			},

			async add(scope, input) {
				const privateEndpoints = (await readSettingsRow(scope.db))?.aiPrivateEndpoints ?? false;
				const values = checkShared(input, privateEndpoints);
				if (input.key === undefined) throw new AiKeyInvalidError("key", "needed");
				const key = checkKey(input.key);
				const now = scope.now();
				const row = await scope.transaction(async (tx) => {
					const [created] = await tx.db
						.insert(installAiKeys)
						.values({ ...values, createdBy: actingPerson(tx.access.actor), createdAt: now, updatedAt: now })
						.returning();
					if (!created) throw new Error("The shared AI key was not saved.");
					await tx.audit("sharedAiKey.add", {
						keyId: created.id,
						name: values.name,
						provider: values.provider,
						model: values.model,
					});
					return created;
				});
				await secrets.set({ owner: { kind: "install" }, name: sharedAiKeySecret(row.id) }, key);
				return sharedView(scope.db, row);
			},

			async update(scope, keyId, input) {
				const before = await findShared(scope.db, keyId);
				const privateEndpoints = (await readSettingsRow(scope.db))?.aiPrivateEndpoints ?? false;
				const values = checkShared(input, privateEndpoints);
				const key = input.key === undefined ? undefined : checkKey(input.key);
				if ((before.provider !== values.provider || before.endpoint !== values.endpoint) && key === undefined) {
					throw new AiKeyInvalidError("key", "needed");
				}
				const row = await scope.transaction(async (tx) => {
					const [updated] = await tx.db
						.update(installAiKeys)
						.set({ ...values, updatedAt: tx.now(), ...(key === undefined ? {} : { testedAt: null, testResult: null }) })
						.where(eq(installAiKeys.id, before.id))
						.returning();
					if (!updated) throw new SharedAiKeyNotFoundError();
					await tx.audit("sharedAiKey.update", {
						keyId: before.id,
						name: values.name,
						provider: values.provider,
						model: values.model,
						keyChanged: key !== undefined,
					});
					return updated;
				});
				if (key !== undefined) await secrets.set({ owner: { kind: "install" }, name: sharedAiKeySecret(row.id) }, key);
				const assigned = await scope.db
					.select({ workspaceId: workspaceAi.workspaceId })
					.from(workspaceAi)
					.where(eq(workspaceAi.sharedKeyId, row.id));
				for (const { workspaceId } of assigned) await changed(workspaceId);
				return sharedView(scope.db, row);
			},

			async remove(scope, keyId) {
				const row = await findShared(scope.db, keyId);
				await scope.transaction(async (tx) => {
					await tx.db
						.update(workspaceAi)
						.set({ sharedKeyId: null, sharedCap: null })
						.where(eq(workspaceAi.sharedKeyId, row.id));
					await tx.db.delete(installAiKeys).where(eq(installAiKeys.id, row.id));
					await tx.audit("sharedAiKey.remove", { keyId: row.id, name: row.name });
				});
				await secrets.remove({ owner: { kind: "install" }, name: sharedAiKeySecret(row.id) });
			},

			async test(scope, keyId) {
				const row = await findShared(scope.db, keyId);
				const provider = isAiProvider(row.provider) ? row.provider : "openaiCompatible";
				const settings = await readSettingsRow(scope.db);
				// A test has no Workspace to pay for it: it is the Install's, and records nothing against a cap.
				let result: AiKeyTest;
				try {
					await secrets.useWith({ owner: { kind: "install" }, name: sharedAiKeySecret(row.id) }, async (value) => {
						await ai.translate({
							connection: {
								provider,
								model: row.model,
								endpoint: row.endpoint,
								key: value,
								privateNetwork: settings?.aiPrivateEndpoints ?? false,
							},
							purpose: "test",
							from: { code: "en", name: "English" },
							to: { code: "fr", name: "Français" },
							texts: ["Hello"],
						});
						return null;
					});
					result = { ok: true, problem: null };
				} catch (error) {
					if (!(error instanceof AiProviderError)) throw error;
					result = { ok: false, problem: error.problem };
				}
				await scope.db
					.update(installAiKeys)
					.set({ testedAt: clock.now(), testResult: result.ok ? "ok" : result.problem })
					.where(eq(installAiKeys.id, row.id));
				return result;
			},

			async assign(scope, workspaceId, keyId, monthlyCap) {
				const [workspace] = /^[0-9a-f-]{36}$/i.test(workspaceId)
					? await scope.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId))
					: [];
				if (!workspace) throw new WorkspaceNotFoundError();
				if (keyId !== null) {
					const key = await findShared(scope.db, keyId);
					if (monthlyCap === null) throw new AiKeyInvalidError("monthlyCap", "needed");
					const cap = checkCap(monthlyCap, true);
					const provider = isAiProvider(key.provider) ? key.provider : "openaiCompatible";
					if (!priceMicros(provider, key.model, key.inputPrice, key.outputPrice))
						throw new AiKeyInvalidError("price", "needed");
					await scope.transaction(async (tx) => {
						await upsertSettings(tx.db, workspace.id, { sharedKeyId: key.id, sharedCap: cap });
						await tx.audit("sharedAiKey.assign", { keyId: key.id, monthlyCap }, { workspaceId: workspace.id });
					});
				} else {
					await scope.transaction(async (tx) => {
						await upsertSettings(tx.db, workspace.id, { sharedKeyId: null, sharedCap: null });
						await tx.audit("sharedAiKey.assign", { keyId: null }, { workspaceId: workspace.id });
					});
				}
				await changed(workspace.id);
			},

			async setPrivateEndpoints(scope, on) {
				await scope.transaction(async (tx) => {
					await writeSettingsRow(tx.db, { aiPrivateEndpoints: on });
					await tx.audit("aiSettings.change", { privateEndpoints: on });
				});
			},
		},

		async readiness(workspaceId) {
			const key = await keyInUse(database.db, workspaceId);
			if (!key) return { key: null, capReached: false, percent: null };
			if (key.cap === null || key.cap <= 0) return { key: key.kind, capReached: false, percent: null };
			const budget = await budgetOf(database.db, workspaceId, key.kind, monthOf(clock.now()));
			return {
				key: key.kind,
				capReached: budget.spent + budget.reserved >= key.cap,
				percent: Math.floor((budget.spent / key.cap) * 100),
			};
		},

		call,

		async releaseStale() {
			const before = new Date(clock.now().getTime() - STALE_RESERVATION_MS);
			const stale = await database.db
				.select()
				.from(aiCalls)
				.where(and(eq(aiCalls.status, "reserved"), lt(aiCalls.at, before)));
			for (const row of stale) {
				await settle(
					row.id,
					{ workspaceId: row.workspaceId, kind: row.key === "shared" ? "shared" : "own", month: row.month },
					row.reservedCost,
					{ status: "failed", usage: { inputTokens: 0, outputTokens: 0 }, cost: 0 },
				);
			}
			return stale.length;
		},

		onChange(listener) {
			listeners.push(listener);
		},
	};
}

/** A key's price in micro-dollars per million tokens: the one given, else WebCraft's estimate, else null. */
function priceMicros(
	provider: AiProvider,
	model: string,
	input: number | null,
	output: number | null,
): { input: number; output: number } | null {
	if (input !== null && output !== null) return { input, output };
	const known = knownAiPrice(provider, model);
	return known ? { input: toMicros(known.input), output: toMicros(known.output) } : null;
}

function priceView(
	provider: AiProvider,
	model: string,
	input: number | null,
	output: number | null,
): AiPriceView | null {
	if (input !== null && output !== null)
		return { input: fromMicros(input), output: fromMicros(output), estimated: false };
	const known = knownAiPrice(provider, model);
	return known ? { ...known, estimated: true } : null;
}

/** Names that only ever reach this server or its own network. */
const LOCAL_ONLY_SUFFIXES = ["localhost", "local", "internal", "home.arpa"];

/**
 * An OpenAI-compatible provider's endpoint, as stored: an https address on the internet without
 * credentials (whether its host resolves to a public address is the guarded fetcher's to check on
 * every call). A shared key's may be http and inside the network while the Superadmin allows it.
 * Every other provider has none.
 */
function checkEndpoint(provider: AiProvider, endpoint: string | null, privateNetwork: boolean): string | null {
	if (provider !== "openaiCompatible") {
		if (endpoint !== null && endpoint.trim() !== "") throw new AiKeyInvalidError("endpoint", "host");
		return null;
	}
	const text = endpoint?.trim() ?? "";
	if (text === "") throw new AiKeyInvalidError("endpoint", "needed");
	if (text.length > AI_KEY_LIMITS.endpoint || !URL.canParse(text)) throw new AiKeyInvalidError("endpoint", "format");
	const url = new URL(text);
	if (url.protocol !== "https:" && !(privateNetwork && url.protocol === "http:")) {
		throw new AiKeyInvalidError("endpoint", "scheme");
	}
	if (url.username || url.password || url.search || url.hash) throw new AiKeyInvalidError("endpoint", "format");
	if (!privateNetwork && !publicHost(url.hostname)) throw new AiKeyInvalidError("endpoint", "host");
	return url.toString().replace(/\/+$/, "");
}

function publicHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	const literal = host.startsWith("[") ? host.slice(1, -1) : host;
	if (isIP(literal)) return isPublicAddress(literal);
	if (!host.includes(".")) return false;
	return !LOCAL_ONLY_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function checkModel(model: string): string {
	const text = model.trim();
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
	if (text === "" || text.length > AI_KEY_LIMITS.model || /[\u0000-\u001f\u007f\s]/.test(text)) {
		throw new AiKeyInvalidError("model", "format");
	}
	return text;
}

function checkKey(key: string): string {
	const text = key.trim();
	if (text === "" || text.length > AI_KEY_LIMITS.key || /\s/.test(text)) throw new AiKeyInvalidError("key", "format");
	return text;
}

function checkPrice(price: AiPrice | null): AiPrice | null {
	if (price === null) return null;
	const fine = (value: number) => Number.isFinite(value) && value >= 0 && value <= 10_000;
	if (!fine(price.input) || !fine(price.output)) throw new AiKeyInvalidError("price", "range");
	return price;
}

/** A cap in micro-dollars, from dollars: at least a cent. Null for none, unless one is needed. */
function checkCap(monthlyCap: number | null, needed: boolean): number | null {
	if (monthlyCap === null) {
		if (needed) throw new AiKeyInvalidError("monthlyCap", "needed");
		return null;
	}
	if (!Number.isFinite(monthlyCap) || monthlyCap < 0.01 || monthlyCap > AI_CAP_MAX) {
		throw new AiKeyInvalidError("monthlyCap", "range");
	}
	return toMicros(monthlyCap);
}

function checkShared(input: SharedAiKeyInput, privateEndpoints: boolean) {
	const name = input.name.trim();
	if (name === "" || name.length > AI_KEY_LIMITS.name) throw new AiKeyInvalidError("name", "format");
	const model = checkModel(input.model);
	const price = input.price === undefined ? null : checkPrice(input.price);
	// A shared key always comes with a cap, so its calls need a price.
	if (!price && !knownAiPrice(input.provider, model)) throw new AiKeyInvalidError("price", "needed");
	return {
		name,
		provider: input.provider,
		model,
		endpoint: checkEndpoint(input.provider, input.endpoint, privateEndpoints),
		inputPrice: price ? toMicros(price.input) : null,
		outputPrice: price ? toMicros(price.output) : null,
	};
}
