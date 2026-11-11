/** Live sources are captured once, then use the ordinary immutable-file Import pipeline. */
import { createHash } from "node:crypto";
import { importFiles, importRuns, imports } from "@webcraft/db/schema";
import type { LiveSurvey, SourceItem } from "@webcraft/module-sdk";
import { and, eq, inArray, sql } from "drizzle-orm";
import { askConfirmation, type Confirmation, useConfirmation } from "../confirmations.ts";
import type { JobContext, JobQueue } from "../jobs/define.ts";
import type { InstallStorage } from "../media/install-storage.ts";
import { siteFolder } from "../media/storage.ts";
import type { ModuleHost, RunningSource } from "../modules/host.ts";
import { actingPerson, can } from "../permissions/can.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { PermissionDeniedError } from "../tenancy/errors.ts";
import { CONNECTION_LIFETIME, connectionOf, type ImportConnection } from "./connection.ts";
import { ImportInvalidError, ImportNotFoundError, ImportRunningError } from "./errors.ts";
import { deleteFile, IMPORT_FILE_LIFETIME_MS } from "./files.ts";
import { createImport } from "./runs.ts";
import { importsSurvey, type SourceFileDetails, sourceFileOf, surveyItems } from "./survey.ts";
import { partKey, sourceFor } from "./uploads.ts";

export type { ImportConnection } from "./connection.ts";
export type ConnectInput = {
	source: string;
	name: string;
	importId?: string;
	address?: string;
	includeHidden?: boolean;
	username?: string;
	applicationPassword?: string;
};
export const credentialName = (importId: string) => `import:${importId}:credentials`;
const invalid = (rule: string, message: string): never => {
	throw new ImportInvalidError([{ at: "connection", rule, message }]);
};
function addressOf(address: string): string {
	try {
		const url = new URL(address);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname.includes("%") ||
			address.includes("\\")
		)
			throw new Error();
		return `${url.origin}${url.pathname.replace(/\/+$/, "")}/`;
	} catch {
		return invalid("address", "Use the Site's HTTPS address without credentials, query or fragment.");
	}
}
export async function connectSource(
	scope: SiteScope,
	deps: { modules: ModuleHost; storage: InstallStorage; jobs: JobQueue },
	input: ConnectInput,
) {
	const source = await sourceFor(scope, deps.modules, input.source);
	const liveSource = source.live;
	if (!liveSource) return invalid("source", "This source does not connect to a live site.");
	const previous = input.importId ? await scope.first(imports, eq(imports.id, input.importId)) : undefined;
	if (input.importId && (!previous || previous.source !== input.source)) throw new ImportNotFoundError();
	const before = connectionOf(previous?.connection);
	const address = input.address === undefined && before ? before.address : addressOf(input.address ?? "");
	if (before && address !== before.address)
		return invalid("source", "Start a new Import for a different source address.");
	const hidden = input.includeHidden ?? before?.includeHidden ?? false;
	const replacing = input.username !== undefined || input.applicationPassword !== undefined;
	if (replacing && (!input.username || input.username.includes(":") || !input.applicationPassword))
		return invalid("credentials", "Enter both a username and an application password.");
	if (!replacing && (!before || new Date(before.expiresAt).getTime() <= scope.now().getTime()))
		return invalid("credentials", "The saved login expired. Enter it again.");
	const created =
		previous ??
		(await createImport(scope, deps.modules, {
			name: input.name,
			source: input.source,
			settings: { language: null, types: [] },
		}));
	const importId = created.id;
	// Serialize reconnects with starts/removal. The stored credential is never placed in a job or Module.
	const result = await scope
		.transaction(async (tx) => {
			const [current] = await tx.db
				.select()
				.from(imports)
				.where(tx.where(imports, eq(imports.id, importId)))
				.for("update");
			if (!current) throw new ImportNotFoundError();
			if (connectionOf(current.connection)?.revision !== before?.revision)
				return invalid("connection", "The connection changed. Reload it and try again.");
			const running = await tx.first(
				importRuns,
				and(eq(importRuns.importId, importId), inArray(importRuns.status, ["waiting", "running"])),
			);
			if (running) throw new ImportRunningError(running.id);
			const candidateName = replacing ? `${credentialName(importId)}:test` : credentialName(importId);
			if (replacing)
				await tx.secrets.set(
					candidateName,
					`Basic ${Buffer.from(`${input.username}:${input.applicationPassword}`, "utf8").toString("base64")}`,
				);
			const connection: ImportConnection = {
				revision: crypto.randomUUID(),
				address,
				includeHidden: hidden,
				expiresAt: before?.expiresAt ?? new Date(tx.now().getTime() + CONNECTION_LIFETIME).toISOString(),
			};
			if (replacing && (!before || new Date(before.expiresAt).getTime() <= tx.now().getTime()))
				connection.expiresAt = new Date(tx.now().getTime() + CONNECTION_LIFETIME).toISOString();
			let survey: LiveSurvey;
			try {
				survey = await liveSource(scope, { ...connection, secretName: candidateName }).test();
			} catch {
				return invalid(
					"connection",
					"WordPress refused the connection. Check the address, application password and source permissions, then try again.",
				);
			} finally {
				if (replacing) await tx.secrets.remove(candidateName);
			}
			if (replacing)
				await tx.secrets.set(
					credentialName(importId),
					`Basic ${Buffer.from(`${input.username}:${input.applicationPassword}`, "utf8").toString("base64")}`,
				);
			await tx.update(imports, { connection, updatedAt: tx.now() }, eq(imports.id, importId));
			await tx.audit("import.connect", { importId, includeHidden: hidden });
			const target = await deps.storage.current();
			const id = crypto.randomUUID();
			const file = await tx.insert(importFiles, {
				id,
				source: input.source,
				uploadedBy: actingPerson(tx.access.actor),
				fileName: new URL(address).host,
				status: "surveying",
				sizeBytes: 0,
				receivedBytes: 0,
				partBytes: 1024 * 1024,
				parts: [],
				storage: target.kind,
				key: `${siteFolder(tx.site)}/imports/${id}`,
				details: { live: { importId, connection, survey } },
				surveyStartedAt: tx.now(),
				createdAt: tx.now(),
				expiresAt: new Date(tx.now().getTime() + IMPORT_FILE_LIFETIME_MS),
			});

			return {
				importId,
				file,
				connection: {
					address,
					includeHidden: hidden,
					roles: survey.roles,
					types: survey.types.map(({ key, label, count }) => ({ key, label, count })),
				},
			};
		})
		.catch(async (error) => {
			if (!previous) {
				await scope.secrets.remove(credentialName(importId));
				await scope.delete(imports, eq(imports.id, importId));
			}
			throw error;
		});
	await deps.jobs.send(importsSurvey, { siteId: scope.site.id, fileId: result.file.id });
	return result;
}

/** Writes bounded NDJSON parts as the Module yields items; a partial read is never usable. */
export async function captureLive(context: JobContext, row: typeof importFiles.$inferSelect, source: RunningSource) {
	const live = (row.details as SourceFileDetails).live;
	if (!live || !source.live || !row.uploadedBy) throw new Error("No live source.");
	const actor = await context.actors.person(row.uploadedBy);
	const scope = await context.data.site({ actor, via: { kind: "admin" } }, row.siteId, "import.run");
	await sourceFor(scope, context.modules, row.source);
	const current = await scope.first(imports, eq(imports.id, live.importId));
	if (!current || JSON.stringify(current.connection) !== JSON.stringify(live.connection))
		throw new Error("The connection changed.");
	if (new Date(live.connection.expiresAt).getTime() <= scope.now().getTime())
		throw new Error("The connection expired.");
	const backend = await context.storage.holding(row.storage as "disk" | "s3");
	let buffer = "";
	let size = 0;
	const parts: string[] = [];
	async function flush() {
		if (!buffer) return;
		const bytes = new TextEncoder().encode(buffer);
		size += bytes.length;
		if (size > 1024 ** 3) throw new Error("The source exceeds the snapshot limit.");
		const key = partKey(row, parts.length);
		const hash = createHash("sha256").update(bytes).digest("hex");
		// Removal locks the same file: it either sees this part or prevents its write.
		try {
			await scope.transaction(async (tx) => {
				const [file] = await tx.db
					.select({ id: importFiles.id })
					.from(importFiles)
					.where(tx.where(importFiles, eq(importFiles.id, row.id)))
					.for("update");
				if (!file) throw new Error("The Import was removed.");
				await backend.put(key, bytes, "application/octet-stream");
				// Track every part even if a subsequent fetch fails, so purge removes partial captures.
				await tx.update(
					importFiles,
					{ parts: [...parts, hash], sizeBytes: size, receivedBytes: size },
					eq(importFiles.id, row.id),
				);
			});
		} catch (error) {
			await backend.delete(key);
			throw error;
		}
		parts.push(hash);
		buffer = "";
	}
	const stream = source
		.live(scope, { ...live.connection, secretName: credentialName(live.importId) })
		.read(live.survey);
	async function* capturing(): AsyncIterable<SourceItem> {
		for await (const item of stream) {
			buffer += `${JSON.stringify(item)}\n`;
			if (buffer.length >= 1024 * 1024) await flush();
			yield item;
		}
		await flush();
	}
	return surveyItems(capturing());
}

/** Reading the completed snapshot never makes another REST request. */
export async function* readSource(
	source: RunningSource,
	storage: InstallStorage,
	file: typeof importFiles.$inferSelect,
): AsyncIterable<SourceItem> {
	if (source.kind !== "live") {
		yield* source.read(sourceFileOf(storage, file));
		return;
	}
	if (!(file.details as SourceFileDetails).live || file.status !== "ready") throw new Error("The source is not ready.");
	let buffer = "";
	for await (const chunk of sourceFileOf(storage, file).text()) {
		buffer += chunk;
		let end = buffer.indexOf("\n");
		while (end >= 0) {
			yield JSON.parse(buffer.slice(0, end)) as SourceItem;
			buffer = buffer.slice(end + 1);
			end = buffer.indexOf("\n");
		}
	}
	if (buffer) throw new Error("The source snapshot is incomplete.");
}

export async function removeImport(
	scope: SiteScope,
	modules: ModuleHost,
	storage: InstallStorage,
	importId: string,
	confirmation?: string,
): Promise<{ removed: false; confirmation: Confirmation } | { removed: true }> {
	return scope.transaction(async (tx) => {
		const [row] = await tx.db
			.select()
			.from(imports)
			.where(tx.where(imports, eq(imports.id, importId)))
			.for("update");
		if (!row) throw new ImportNotFoundError();
		if (row.connection) {
			// Staff can revoke a saved live login even when its Module is off or no longer installed.
			const resource = { level: "site", workspaceId: tx.site.workspaceId, siteId: tx.site.id } as const;
			if (!can(tx.access.actor, "structure.edit", resource)) throw new PermissionDeniedError("structure.edit");
		} else if (row.source !== "csv") await sourceFor(tx, modules, row.source);
		const running = await tx.first(
			importRuns,
			and(eq(importRuns.importId, importId), inArray(importRuns.status, ["waiting", "running"])),
		);
		if (running) throw new ImportRunningError(running.id);
		const request = {
			action: "import.remove",
			target: importId,
			preview: { name: row.name, runs: row.runs, updatedAt: row.updatedAt.toISOString() },
		};
		if (!confirmation) return { removed: false, confirmation: await askConfirmation(tx, request) };
		await useConfirmation(tx, confirmation, request);
		const files = await tx.db
			.select()
			.from(importFiles)
			.where(tx.where(importFiles, sql`${importFiles.details}->'live'->>'importId' = ${importId}`))
			.for("update");
		for (const file of files) await deleteFile(tx, storage, file);
		await tx.secrets.remove(credentialName(importId));
		await tx.secrets.remove(`${credentialName(importId)}:test`);
		await tx.delete(imports, eq(imports.id, importId));
		await tx.audit("import.remove", { importId });
		return { removed: true };
	});
}
