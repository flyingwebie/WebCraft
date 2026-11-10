import type { Database } from "@webcraft/db";

import type { Clock } from "../clock.ts";
import type { InstallConfig } from "../config.ts";
import type { SiteHost } from "../site-pages/index.ts";
import type { DataLayer, SiteScope } from "../tenancy/data-layer.ts";
import { createCursors } from "./cursor.ts";
import {
	anyKeyAllows,
	type ContentKeyChange,
	type ContentKeyView,
	contentKeyHasher,
	createContentKey,
	type FoundContentKey,
	findContentKey,
	type NewContentKey,
	noteContentKeyUse,
	revokeContentKey,
	updateContentKey,
} from "./keys.ts";
import { type ContentApiChange, type ContentApiView, contentApiView, updateContentApi } from "./manage.ts";
import { type ContentRead, readContent } from "./read.ts";
import { type ContentApiSettings, readContentApiSettings } from "./settings.ts";

export { CONTENT_API_ERRORS, ContentApiError, type ContentApiErrorCode } from "./errors.ts";
export {
	CONTENT_API_LIMITS,
	CONTENT_KEY_LIMITS,
	CONTENT_KEY_PREFIX,
	ContentApiInvalidError,
	type ContentKeyChange,
	ContentKeyNotFoundError,
	type ContentKeyView,
	type NewContentKey,
	normaliseOrigin,
} from "./keys.ts";
export { CONTENT_API_BASE, type ContentApiChange, type ContentApiView } from "./manage.ts";
export { contentApiDocument } from "./openapi.ts";
export { BODY_FORMATS, CONTENT_API_PAGE, CONTENT_API_QUERY_PROBLEMS, carriesKey } from "./params.ts";
export type { ContentRead } from "./read.ts";
export type { ContentApiHidden, ContentApiSettings } from "./settings.ts";

/**
 * A Site's Content API as one request on one of its hostnames sees it (ADR 0029): only ever open
 * while the Site has it switched on.
 */
export type ContentApiDoor = {
	settings: ContentApiSettings;
	/** The Site's working key a request carries (the `Authorization: Bearer` value), or why there is none. */
	key(secret: string | null): Promise<FoundContentKey>;
	/** Whether any working key of the Site lists this origin (what a CORS preflight is answered by). */
	allowsOrigin(origin: string): Promise<boolean>;
	/** Counts one request of a key in its usage. */
	noteUse(key: { id: string; lastUsedAt: Date | null }): Promise<void>;
	/**
	 * Answers a path of the API (its parts after `/_content/v1`) with its query string: published
	 * content as JSON, and whether the page cache may keep it. Throws `ContentApiError` for a refusal.
	 */
	read(segments: readonly string[], query: URLSearchParams): Promise<ContentRead>;
};

/**
 * The Content API (ADR 0029, GLOSSARY.md › Content API): a Site's read-only, versioned API that gives
 * frontends built elsewhere its published content, on each of its domains and its Staging address at
 * `/_content/v1/…`. Staff switch it on per Site, hide Post Types and Fields, and make its Content keys
 * (Site settings: open the Site with `structure.edit`).
 */
export type ContentApi = {
	/** The switch, what is hidden, the keys and where it answers. */
	get(scope: SiteScope): Promise<ContentApiView>;
	/** Switches it on or off and changes what is hidden. Logged as `contentApi.change`. */
	update(scope: SiteScope, change: ContentApiChange): Promise<ContentApiView>;
	/** Makes a Content key and answers it, the only time it is shown. Logged as `contentKey.create`. */
	createKey(scope: SiteScope, input: NewContentKey): Promise<{ key: ContentKeyView; secret: string }>;
	/** Renames a key or changes its origins. Logged as `contentKey.update`. */
	updateKey(scope: SiteScope, keyId: string, change: ContentKeyChange): Promise<ContentKeyView>;
	/** Revokes a key at once. Logged as `contentKey.revoke`. */
	revokeKey(scope: SiteScope, keyId: string): Promise<ContentKeyView>;
	/** The Site's Content API for a request on `host`, or null while the Site has it off. */
	open(host: SiteHost): Promise<ContentApiDoor | null>;
};

export function createContentApi({
	database,
	data,
	config,
	clock,
	keyHash,
	cursorKey,
}: {
	database: Database;
	data: DataLayer;
	config: InstallConfig;
	clock: Clock;
	/** The key Content keys are hashed under (`contentKeyKey`). */
	keyHash: CryptoKey;
	/** The key list cursors are signed with (`contentCursorKey`). */
	cursorKey: CryptoKey;
}): ContentApi {
	const hash = contentKeyHasher(keyHash);
	const cursors = createCursors(cursorKey);
	return {
		get: (scope) => contentApiView(scope, config),
		update: (scope, change) => updateContentApi(scope, change, config),
		createKey: (scope, input) => createContentKey(scope, input, hash),
		updateKey: updateContentKey,
		revokeKey: revokeContentKey,

		async open(host) {
			const scope = data.visitors(host.site);
			const settings = await readContentApiSettings(scope);
			if (!settings.enabled) return null;
			return {
				settings,
				key: (secret) => findContentKey(scope, secret, hash),
				allowsOrigin: (origin) => anyKeyAllows(scope, origin),
				noteUse: (key) => noteContentKeyUse(database, host.site, key, clock.now()),
				read: (segments, query) => readContent({ scope, host, settings, cursors }, segments, query),
			};
		},
	};
}
