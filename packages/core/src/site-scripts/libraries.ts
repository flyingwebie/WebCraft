/**
 * A Site's Libraries (ADR 0023): ready-made script packages Staff add at a fixed version, by package
 * and version from the npm registry or by an https address. WebCraft downloads each once through the
 * guarded fetcher, checks it (the registry's integrity hash, a size limit), keeps it in the Install's
 * storage with its own integrity hash, and serves it from the Site's domain as a file named by its
 * hash, `/_wc/lib/<hash>-<file name>`, so pages need no outside host and visitors' addresses go to no
 * CDN. A Library never changes unless Staff update it; checking for updates only says which can be.
 *
 * Libraries are Structure (`structure.edit`, Staff only) with no Draft: a change applies at once and
 * clears the page cache. Pages load them before the Site script, also in Edit mode (ADR 0022), never
 * in Safe mode.
 */
import { createHash } from "node:crypto";

import { libraries } from "@webcraft/db/schema";
import type { PageLibrary } from "@webcraft/renderer";
import { asc, eq, sql } from "drizzle-orm";

import { clearPageCache } from "../content/page-cache.ts";
import { type GuardedFetch, GuardedFetchError } from "../guarded-fetch.ts";
import { isUuid } from "../ids.ts";
import type { InstallStorage } from "../media/install-storage.ts";
import { type StorageKind, siteFolder } from "../media/storage.ts";
import type { SiteScope, VisitorScope } from "../tenancy/data-layer.ts";
import { LibraryNotFoundError, LibraryRefusedError } from "./errors.ts";
import {
	compareVersions,
	latestVersion,
	packageFile,
	packageVersion,
	readFilePath,
	readPackageName,
	readVersion,
} from "./npm.ts";
import { retiredLibrary, retireLibraryFile, unretireLibraryFile } from "./retired.ts";
import { outsideAddress } from "./snippets.ts";

/** Where every Site serves its Libraries: `/_wc/lib/<hash>-<file name>`. */
export const LIBRARY_PATH = "/_wc/lib/";

/** The largest Library file, in bytes. */
export const LIBRARY_MAX_BYTES = 5 * 1024 * 1024;

/** How many Libraries a Site holds at most. */
export const LIBRARIES_PER_SITE = 30;

/** A Library as Staff add it: a package of the npm registry at a version (and a file of it), or an https address. */
export type LibraryInput =
	| { source: "npm"; packageName: string; version: string; file?: string | null }
	| { source: "url"; url: string };

/** A Library as the Libraries screen shows it. */
export type Library = {
	id: string;
	source: "npm" | "url";
	/** What it is called: its package's name, or its file's name for one added by address. */
	name: string;
	packageName: string | null;
	version: string | null;
	file: string | null;
	url: string | null;
	/** Where the Site serves it. */
	src: string;
	integrity: string;
	size: number;
	licence: string | null;
	/** The newest version the registry had when last checked. */
	latestVersion: string | null;
	/** That version when it is newer than the one the Site holds: Staff may update to it. */
	newerVersion: string | null;
	checkedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
};

/** What Libraries are downloaded and kept with. */
export type LibraryDeps = { fetch: GuardedFetch; storage: InstallStorage };

type Row = typeof libraries.$inferSelect;

/** A downloaded Library file, ready to keep. */
type Download = {
	bytes: Uint8Array;
	fileName: string;
	packageName: string | null;
	version: string | null;
	file: string | null;
	url: string | null;
	licence: string | null;
	latestVersion: string | null;
};

function view(row: Row): Library {
	const newer =
		row.version && row.latestVersion && compareVersions(row.latestVersion, row.version) > 0 ? row.latestVersion : null;
	return {
		id: row.id,
		source: row.source === "url" ? "url" : "npm",
		name: row.packageName ?? row.fileName,
		packageName: row.packageName,
		version: row.version,
		file: row.file,
		url: row.url,
		src: srcOf(row),
		integrity: row.integrity,
		size: row.size,
		licence: row.licence,
		latestVersion: row.latestVersion,
		newerVersion: newer,
		checkedAt: row.checkedAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** The name a Library's file is served under: `<hash>-<file name>`. */
function servedName(row: Pick<Row, "hash" | "fileName">): string {
	return `${row.hash}-${row.fileName}`;
}

function srcOf(row: Pick<Row, "hash" | "fileName">): string {
	return `${LIBRARY_PATH}${servedName(row)}`;
}

/** The Site's Libraries, in the order pages load them. */
export async function listLibraries(scope: SiteScope): Promise<Library[]> {
	return (
		await scope.select(libraries, undefined, { orderBy: [asc(libraries.position), asc(libraries.createdAt)] })
	).map(view);
}

/**
 * Downloads a Library and adds it at the end of the Site's list (open the Site with `structure.edit`).
 * Refuses what can't be one (`LibraryRefusedError`, with the problem).
 */
export async function addLibrary(scope: SiteScope, deps: LibraryDeps, input: LibraryInput): Promise<Library> {
	const download = await downloadLibrary(deps.fetch, input);
	if ((await scope.count(libraries)) >= LIBRARIES_PER_SITE) throw new LibraryRefusedError("limit");
	const file = await keep(scope, deps.storage, download.bytes, download.fileName);
	return scope.transaction(async (tx) => {
		const [last] = await tx.select(libraries, undefined, { orderBy: [sql`${libraries.position} desc`], limit: 1 });
		const now = tx.now();
		const row = await tx.insert(libraries, {
			source: input.source,
			packageName: download.packageName,
			version: download.version,
			file: download.file,
			url: download.url,
			...file,
			licence: download.licence,
			latestVersion: download.latestVersion,
			checkedAt: download.latestVersion ? now : null,
			position: (last?.position ?? -1) + 1,
			createdAt: now,
			updatedAt: now,
		});
		await unretireLibraryFile(tx, servedName(row));
		await clearPageCache(tx);
		await tx.audit("library.add", {
			libraryId: row.id,
			name: row.packageName ?? row.fileName,
			version: row.version,
			url: row.url,
			integrity: row.integrity,
		});
		return view(row);
	});
}

/**
 * Updates a Library, only when Staff ask: one from the registry to `version` (its newest version
 * unless given), the same file of the package; one added by address is downloaded again from there.
 * The file it replaces is still served for 30 days, for pages loaded before.
 */
export async function updateLibrary(
	scope: SiteScope,
	deps: LibraryDeps,
	libraryId: string,
	version?: string,
): Promise<Library> {
	const current = await findRow(scope, libraryId);
	const input: LibraryInput =
		current.source === "url"
			? { source: "url", url: current.url ?? "" }
			: {
					source: "npm",
					packageName: current.packageName ?? "",
					version: version ?? (await latestVersion(deps.fetch, current.packageName ?? "")),
					file: current.file,
				};
	const download = await downloadLibrary(deps.fetch, input);
	const file = await keep(scope, deps.storage, download.bytes, download.fileName);
	return scope.transaction(async (tx) => {
		const row = await findRow(tx, current.id);
		const now = tx.now();
		const [updated] = await tx.update(
			libraries,
			{
				version: download.version,
				file: download.file,
				...file,
				licence: download.licence,
				latestVersion: download.latestVersion ?? row.latestVersion,
				checkedAt: download.latestVersion ? now : row.checkedAt,
				updatedAt: now,
			},
			eq(libraries.id, row.id),
		);
		if (servedName(row) !== servedName(file)) {
			await retireLibraryFile(tx, {
				name: servedName(row),
				storage: row.storage as StorageKind,
				storageKey: row.storageKey,
			});
			await unretireLibraryFile(tx, servedName(file));
			await clearPageCache(tx);
		}
		await tx.audit("library.update", {
			libraryId: row.id,
			name: row.packageName ?? row.fileName,
			from: row.version,
			to: download.version,
			integrity: file.integrity,
		});
		return view(updated as Row);
	});
}

/** Removes a Library from the Site; its file is still served for 30 days, for pages loaded before. */
export async function removeLibrary(scope: SiteScope, libraryId: string): Promise<void> {
	await scope.transaction(async (tx) => {
		const row = await findRow(tx, libraryId);
		await tx.delete(libraries, eq(libraries.id, row.id));
		await retireLibraryFile(tx, {
			name: servedName(row),
			storage: row.storage as StorageKind,
			storageKey: row.storageKey,
		});
		await clearPageCache(tx);
		await tx.audit("library.remove", {
			libraryId: row.id,
			name: row.packageName ?? row.fileName,
			version: row.version,
		});
	});
}

/**
 * Asks the registry for the newest version of each of the Site's Libraries from it, and answers the
 * list with what can be updated (`newerVersion`). Nothing is updated. A package the registry doesn't
 * answer for keeps what was last known.
 */
export async function checkLibraryUpdates(scope: SiteScope, deps: LibraryDeps): Promise<Library[]> {
	const rows = await scope.select(libraries, eq(libraries.source, "npm"));
	for (const row of rows) {
		let newest: string;
		try {
			newest = await latestVersion(deps.fetch, row.packageName ?? "");
		} catch (error) {
			if (error instanceof LibraryRefusedError) continue;
			throw error;
		}
		await scope.update(libraries, { latestVersion: newest, checkedAt: scope.now() }, eq(libraries.id, row.id));
	}
	return listLibraries(scope);
}

async function findRow(scope: Pick<SiteScope, "first">, libraryId: string): Promise<Row> {
	const row = isUuid(libraryId) ? await scope.first(libraries, eq(libraries.id, libraryId)) : undefined;
	if (!row) throw new LibraryNotFoundError();
	return row;
}

/** Downloads what a Library holds: a package's file from the registry, or the file at an address. */
async function downloadLibrary(fetch: GuardedFetch, input: LibraryInput): Promise<Download> {
	if (input.source === "npm") {
		const packageName = readPackageName(input.packageName);
		const version = await packageVersion(fetch, packageName, readVersion(input.version));
		const file = await packageFile(fetch, version, input.file ? readFilePath(input.file) : null, LIBRARY_MAX_BYTES);
		if (file.bytes.length === 0) throw new LibraryRefusedError("empty");
		let newest: string | null = null;
		try {
			newest = await latestVersion(fetch, packageName);
		} catch {
			// Whether a newer version exists is checked again later.
		}
		return {
			bytes: file.bytes,
			fileName: fileNameOf(file.path),
			packageName,
			version: version.version,
			file: file.path,
			url: null,
			licence: version.license,
			latestVersion: newest,
		};
	}
	const url = outsideAddress(input.url);
	if (!url) throw new LibraryRefusedError("url");
	let response: Response;
	try {
		response = await fetch(new Request(url), {
			allowedHosts: [new URL(url).hostname],
			maxBytes: LIBRARY_MAX_BYTES,
			timeoutMs: 30_000,
		});
	} catch (error) {
		if (error instanceof GuardedFetchError && error.problem === "size")
			throw new LibraryRefusedError("size", { cause: error });
		throw new LibraryRefusedError("unreachable", { cause: error });
	}
	if (!response.ok) throw new LibraryRefusedError(response.status === 404 ? "notFound" : "unreachable");
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length === 0) throw new LibraryRefusedError("empty");
	return {
		bytes,
		fileName: fileNameOf(new URL(url).pathname),
		packageName: null,
		version: null,
		file: null,
		url,
		licence: null,
		latestVersion: null,
	};
}

/** The file name a Library is served under: its own name's letters, digits, dots and dashes, ending in `.js`. */
function fileNameOf(path: string): string {
	const base = (path.split("/").at(-1) ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
	const name = (base || "library").replace(/\.js$/i, "").slice(0, 80);
	return `${name}.js`;
}

/** Stores a Library file in the Install's storage, under its hash, and answers what the Library records of it. */
async function keep(
	scope: Pick<SiteScope, "site">,
	storage: InstallStorage,
	bytes: Uint8Array,
	fileName: string,
): Promise<Pick<Row, "fileName" | "hash" | "integrity" | "size" | "storage" | "storageKey">> {
	const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
	const integrity = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
	const backend = await storage.current();
	const storageKey = `${siteFolder(scope.site)}/libraries/${hash}-${fileName}`;
	await backend.put(storageKey, bytes, "text/javascript; charset=utf-8");
	return { fileName, hash, integrity, size: bytes.length, storage: backend.kind, storageKey };
}

/** The Site's Libraries as a page loads them, in order. */
export async function pageLibraries(scope: Pick<VisitorScope, "select">): Promise<PageLibrary[]> {
	const rows = await scope.select(libraries, undefined, {
		orderBy: [asc(libraries.position), asc(libraries.createdAt)],
	});
	return rows.map((row) => ({ name: row.packageName ?? row.fileName, src: srcOf(row), integrity: row.integrity }));
}

/** A Library file as the Site serves it: its bytes and the hash its name holds. */
export type LibraryFile = { hash: string; bytes: Uint8Array };

/** The Site's Library file by the name it is served under: a Library's, or one replaced in the last 30 days. */
export async function libraryFile(
	scope: Pick<VisitorScope, "first" | "now">,
	storage: InstallStorage,
	name: string,
): Promise<LibraryFile | null> {
	const match = /^([0-9a-f]{16})-([A-Za-z0-9._-]+\.js)$/.exec(name);
	if (!match) return null;
	const [, hash = "", fileName = ""] = match;
	const row = await scope.first(libraries, sql`${libraries.hash} = ${hash} and ${libraries.fileName} = ${fileName}`);
	const stored = row
		? { storage: row.storage as StorageKind, storageKey: row.storageKey }
		: await retiredLibrary(scope, name);
	if (!stored) return null;
	const bytes = await (await storage.holding(stored.storage)).read(stored.storageKey);
	return bytes ? { hash, bytes } : null;
}
