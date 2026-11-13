/**
 * The npm registry, as Libraries need it (ADR 0023): a package version's manifest, its newest
 * version, and one file of its archive, checked against the integrity hash the registry gives. Every
 * call goes through the guarded fetcher, to the registry's host only.
 */
import { type GuardedFetch, GuardedFetchError } from "../guarded-fetch.ts";
import { LibraryRefusedError } from "./errors.ts";
import { ArchiveTooLargeError, gunzip, readTar } from "./tar.ts";

/** The registry Libraries come from. */
export const NPM_REGISTRY = "https://registry.npmjs.org";

/** The largest package archive downloaded, in bytes. */
const ARCHIVE_MAX_BYTES = 20 * 1024 * 1024;

/** The most a package archive may unpack to: it is read in memory, so a small archive can't fill it. */
export const LIBRARY_ARCHIVE_UNPACKED_MAX_BYTES = 64 * 1024 * 1024;

/** The largest list of a package's versions read, in bytes. */
const VERSIONS_MAX_BYTES = 20 * 1024 * 1024;

/** A package name: lower case, optionally under a scope (`@scope/name`). */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

/** An exact version (`3.13.0`, `4.0.0-beta.2`). */
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** A partial version: the newest release starting with it (`3`, `3.13`). */
const PARTIAL = /^\d+(?:\.\d+)?$/;

/** A distribution tag (`latest`, `next`). */
const TAG = /^[a-z][a-z0-9._-]{0,63}$/i;

/** A path to a script file inside a package. */
const FILE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+~/-]{1,300}\.js$/;

/** A package name as the registry takes it; refuses anything that isn't one. */
export function readPackageName(input: string): string {
	const name = input.trim().toLowerCase();
	if (name.length > 214 || !PACKAGE_NAME.test(name)) throw new LibraryRefusedError("name");
	return name;
}

/** A version as given: exact, partial or a tag; refuses anything else. */
export function readVersion(input: string): string {
	const version = input.trim().replace(/^v(?=\d)/, "");
	if (!EXACT.test(version) && !PARTIAL.test(version) && !TAG.test(version)) throw new LibraryRefusedError("version");
	return version;
}

/** A file inside a package as given (`./dist/x.js` reads as `dist/x.js`); refuses anything else. */
export function readFilePath(input: string): string {
	const path = input.trim().replace(/^\.\//, "");
	if (!FILE.test(path)) throw new LibraryRefusedError("file");
	return path;
}

/** What Libraries read of a package version's manifest. */
export type PackageVersion = {
	name: string;
	version: string;
	/** The licence it declares, as data. */
	license: string | null;
	tarball: string;
	integrity: string | null;
	shasum: string | null;
	/** Files it names as its browser build or entry, in the order they are tried. */
	entries: string[];
};

/** The registry's address for a package, then more path. */
function registryUrl(name: string, ...rest: string[]): string {
	// A scoped name keeps its slash: the registry answers `/@scope/name` and `/@scope/name/<version>`.
	return [NPM_REGISTRY, name, ...rest.map(encodeURIComponent)].join("/");
}

async function registryJson(fetch: GuardedFetch, url: string, maxBytes = 5 * 1024 * 1024, accept = "application/json") {
	let response: Response;
	try {
		response = await fetch(new Request(url, { headers: { accept } }), {
			allowedHosts: [new URL(NPM_REGISTRY).hostname],
			maxBytes,
			timeoutMs: 30_000,
		});
	} catch (error) {
		if (error instanceof GuardedFetchError && error.problem === "size")
			throw new LibraryRefusedError("size", { cause: error });
		throw new LibraryRefusedError("unreachable", { cause: error });
	}
	if (response.status === 404) throw new LibraryRefusedError("notFound");
	if (!response.ok) throw new LibraryRefusedError("unreachable");
	try {
		return (await response.json()) as Record<string, unknown>;
	} catch (error) {
		throw new LibraryRefusedError("unreachable", { cause: error });
	}
}

/**
 * The manifest of a package version: an exact one, a tag's (`latest`) or the newest release starting
 * with a partial version (`3.13`). `LibraryRefusedError` (`notFound`) when there is none.
 */
export async function packageVersion(fetch: GuardedFetch, name: string, version: string): Promise<PackageVersion> {
	let exact = version;
	if (PARTIAL.test(version)) {
		const document = await registryJson(
			fetch,
			registryUrl(name),
			VERSIONS_MAX_BYTES,
			"application/vnd.npm.install-v1+json",
		);
		const versions = Object.keys((document.versions ?? {}) as Record<string, unknown>);
		const newest = versions
			.filter((candidate) => /^\d+\.\d+\.\d+$/.test(candidate))
			.filter((candidate) => `${candidate}.`.startsWith(`${version}.`))
			.sort(compareVersions)
			.at(-1);
		if (!newest) throw new LibraryRefusedError("notFound");
		exact = newest;
	}
	const manifest = await registryJson(fetch, registryUrl(name, exact));
	const dist = (manifest.dist ?? {}) as Record<string, unknown>;
	if (typeof manifest.version !== "string" || typeof dist.tarball !== "string")
		throw new LibraryRefusedError("notFound");
	const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
	return {
		name,
		version: manifest.version,
		license: text(manifest.license) ?? text((manifest.license as { type?: unknown } | undefined)?.type),
		tarball: dist.tarball,
		integrity: text(dist.integrity),
		shasum: text(dist.shasum),
		entries: [manifest.jsdelivr, manifest.unpkg, manifest.browser, manifest.main].flatMap((entry) =>
			typeof entry === "string" ? [entry] : [],
		),
	};
}

/** The newest version the registry has for a package (its `latest` tag). */
export async function latestVersion(fetch: GuardedFetch, name: string): Promise<string> {
	const manifest = await registryJson(fetch, registryUrl(name, "latest"));
	if (typeof manifest.version !== "string") throw new LibraryRefusedError("notFound");
	return manifest.version;
}

/**
 * One file of a package version: `file` when given, else the first of the files its manifest names
 * as its browser build or entry that it holds (`index.js` last). The archive is checked against the
 * registry's integrity hash first (`integrity`), and must come from the registry.
 */
export async function packageFile(
	fetch: GuardedFetch,
	version: PackageVersion,
	file: string | null,
	maxBytes: number,
): Promise<{ path: string; bytes: Uint8Array }> {
	const tarball = new URL(version.tarball);
	if (tarball.protocol !== "https:" || tarball.hostname !== new URL(NPM_REGISTRY).hostname) {
		throw new LibraryRefusedError("unreachable");
	}
	let response: Response;
	try {
		response = await fetch(new Request(tarball.toString()), {
			allowedHosts: [tarball.hostname],
			maxBytes: ARCHIVE_MAX_BYTES,
			timeoutMs: 30_000,
		});
	} catch (error) {
		if (error instanceof GuardedFetchError && error.problem === "size")
			throw new LibraryRefusedError("size", { cause: error });
		throw new LibraryRefusedError("unreachable", { cause: error });
	}
	if (!response.ok) throw new LibraryRefusedError(response.status === 404 ? "notFound" : "unreachable");
	const archive = new Uint8Array(await response.arrayBuffer());
	await checkIntegrity(archive, version);
	let files: { path: string; bytes: Uint8Array }[];
	try {
		files = readTar(await gunzip(archive, LIBRARY_ARCHIVE_UNPACKED_MAX_BYTES)).map((entry) => ({
			// Archives hold everything in one top folder (`package/`); paths are read without it.
			path: entry.path.replace(/^[^/]*\//, ""),
			bytes: entry.bytes,
		}));
	} catch (error) {
		if (error instanceof ArchiveTooLargeError) throw new LibraryRefusedError("size", { cause: error });
		throw new LibraryRefusedError("unreachable", { cause: error });
	}
	const byPath = new Map(files.map((entry) => [entry.path, entry.bytes]));
	const candidates = file
		? [file]
		: [...version.entries, "index.js"].flatMap((entry) => {
				const path = entry.trim().replace(/^\.\//, "");
				return path.endsWith(".js") ? [path] : [path, `${path}.js`];
			});
	for (const path of candidates) {
		const bytes = byPath.get(path);
		if (!bytes || !path.endsWith(".js")) continue;
		if (bytes.length > maxBytes) throw new LibraryRefusedError("size");
		return { path, bytes };
	}
	throw new LibraryRefusedError("fileNotFound");
}

/** Refuses an archive that doesn't match the hash the registry gives (`integrity`, else `shasum`). */
async function checkIntegrity(archive: Uint8Array, version: PackageVersion): Promise<void> {
	const data = archive as Uint8Array<ArrayBuffer>;
	const sri = version.integrity?.split(/\s+/).find((entry) => entry.startsWith("sha512-"));
	if (sri) {
		const digest = Buffer.from(await crypto.subtle.digest("SHA-512", data)).toString("base64");
		if (`sha512-${digest}` !== sri) throw new LibraryRefusedError("integrity");
		return;
	}
	if (version.shasum) {
		const digest = Buffer.from(await crypto.subtle.digest("SHA-1", data)).toString("hex");
		if (digest !== version.shasum.toLowerCase()) throw new LibraryRefusedError("integrity");
		return;
	}
	throw new LibraryRefusedError("integrity");
}

/** Compares two versions (`x.y.z`, with an optional pre-release), oldest first. */
export function compareVersions(a: string, b: string): number {
	const parse = (version: string) => {
		const [core = "", pre] = version.split(/[-+]/, 2);
		return {
			numbers: core.split(".").map((part) => Number(part) || 0),
			pre: version.includes("-") ? (pre ?? "") : null,
		};
	};
	const left = parse(a);
	const right = parse(b);
	for (let index = 0; index < 3; index++) {
		const difference = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
		if (difference !== 0) return difference;
	}
	if (left.pre === right.pre) return 0;
	if (left.pre === null) return 1;
	if (right.pre === null) return -1;
	return left.pre < right.pre ? -1 : 1;
}
