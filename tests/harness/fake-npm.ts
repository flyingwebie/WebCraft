/**
 * A fake npm registry on the fake outgoing HTTP: packages made in the test (real gzipped tar archives,
 * with the integrity hashes the registry gives), answered the way the registry answers: a version's
 * manifest, a tag's (`latest`), the list of versions, and the archive.
 */
import { createHash } from "node:crypto";

import type { TestInstall } from "./index.ts";

/** The registry's host, which the fake DNS answers with a public address. */
export const NPM_HOST = "registry.npmjs.org";

/** One version of a fake package: its files (path inside the package → text) and its manifest's fields. */
export type FakeVersion = {
	files: Record<string, string>;
	license?: string;
	main?: string;
	browser?: string;
	unpkg?: string;
	jsdelivr?: string;
	/** Serve an archive that doesn't match the integrity hash the manifest gives. */
	tampered?: boolean;
};

export type FakePackage = {
	/** Adds (or replaces) a version, and makes it `latest` unless told otherwise. */
	publish(version: string, files: FakeVersion, options?: { latest?: boolean }): void;
	/** How many times an archive of this package was downloaded. */
	downloads(): number;
};

/** A fake package on the fake registry, with its first versions; the last one given is `latest`. */
export function fakeNpmPackage(install: TestInstall, name: string, versions: Record<string, FakeVersion>): FakePackage {
	install.dns.answer(NPM_HOST, ["104.16.0.35"]);
	const published = new Map<string, { manifest: Record<string, unknown>; archive: Uint8Array }>();
	let latest = "";
	const base = `https://${NPM_HOST}/${name}`;
	const archiveName = (version: string) => `${base}/-/${name.split("/").at(-1)}-${version}.tgz`;

	install.http.respond("GET", new RegExp(`^${escapeRegExp(base)}/([^/]+)$`), (request) => {
		const tag = decodeURIComponent(new URL(request.url).pathname.split("/").at(-1) ?? "");
		const found = published.get(tag === "latest" ? latest : tag);
		if (!found) return { status: 404, body: '{"error":"Not found"}' };
		return { body: JSON.stringify(found.manifest), headers: { "content-type": "application/json" } };
	});
	install.http.respond("GET", base, () => ({
		body: JSON.stringify({
			name,
			"dist-tags": { latest },
			versions: Object.fromEntries(
				[...published].map(([version, { manifest }]) => [version, { version, dist: manifest.dist }]),
			),
		}),
		headers: { "content-type": "application/vnd.npm.install-v1+json" },
	}));
	install.http.respond("GET", new RegExp(`^${escapeRegExp(base)}/-/`), (request) => {
		const found = [...published.values()].find(
			(entry) => (entry.manifest.dist as { tarball: string }).tarball === request.url,
		);
		return found ? { body: found.archive, headers: { "content-type": "application/octet-stream" } } : { status: 404 };
	});

	const tarballRequests = () => install.http.requests.filter((request) => request.url.startsWith(`${base}/-/`)).length;
	const publish: FakePackage["publish"] = (version, given, options = {}) => {
		const files = { "package.json": JSON.stringify({ name, version }), ...given.files };
		const archive = gzipTar(Object.entries(files).map(([path, text]) => [`package/${path}`, text]));
		const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
		const served = given.tampered ? gzipTar([["package/index.js", "steal()"]]) : archive;
		published.set(version, {
			archive: served,
			manifest: {
				name,
				version,
				license: given.license,
				main: given.main,
				browser: given.browser,
				unpkg: given.unpkg,
				jsdelivr: given.jsdelivr,
				dist: { tarball: archiveName(version), integrity, shasum: createHash("sha1").update(archive).digest("hex") },
			},
		});
		if (options.latest !== false) latest = version;
	};
	for (const [version, files] of Object.entries(versions)) publish(version, files);
	return { publish, downloads: tarballRequests };
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * A gzipped tar archive of text files. A path longer than a header's 100 bytes is written as npm's
 * own packer writes it: in a pax header before the file (`path=…`), whose own header keeps only the
 * start of the path.
 */
export function gzipTar(files: [path: string, text: string][]): Uint8Array {
	const blocks: Uint8Array[] = [];
	const entry = (path: string, type: "0" | "x", body: Uint8Array) => {
		const header = new Uint8Array(512);
		const put = (offset: number, value: string) => header.set(new TextEncoder().encode(value), offset);
		put(0, path.slice(0, 100));
		put(100, "0000644\0");
		put(108, "0000000\0");
		put(116, "0000000\0");
		put(124, `${body.length.toString(8).padStart(11, "0")}\0`);
		put(136, "00000000000\0");
		put(148, "        ");
		put(156, type);
		put(257, "ustar\0");
		put(263, "00");
		const sum = header.reduce((total, byte) => total + byte, 0);
		put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
		blocks.push(header, body, new Uint8Array((512 - (body.length % 512)) % 512));
	};
	for (const [path, text] of files) {
		if (path.length > 100) {
			// A pax record is `<length> path=<path>\n`, its length counting the whole record.
			const rest = ` path=${path}\n`;
			let length = rest.length + 1;
			while (String(length).length + rest.length !== length) length = String(length).length + rest.length;
			entry("PaxHeader", "x", new TextEncoder().encode(`${length}${rest}`));
		}
		entry(path, "0", new TextEncoder().encode(text));
	}
	blocks.push(new Uint8Array(1024));
	const tar = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
	let at = 0;
	for (const block of blocks) {
		tar.set(block, at);
		at += block.length;
	}
	return Bun.gzipSync(tar);
}

/** The Subresource Integrity hash a page checks a file against: `sha384-…`. */
export function integrityOf(text: string): string {
	return `sha384-${createHash("sha384").update(text).digest("base64")}`;
}
