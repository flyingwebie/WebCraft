import webcraftPackage from "../../../package.json" with { type: "json" };

/**
 * This build's WebCraft version: the `version` of the repository's root `package.json`, which a
 * release sets before it is tagged (`v<version>`). The migrate step records it, Backups carry it,
 * and the update check compares it with the newest release.
 */
export const WEBCRAFT_VERSION: string = webcraftPackage.version;

/**
 * The header every answer of `/api/v1` to a signed-in client carries: the Install's WebCraft
 * version (`WEBCRAFT_VERSION`). Never sent to anyone else, so the version isn't announced to the
 * world. In its own file (no further imports) so the CLI's remote side can read it without pulling
 * in the rest of `@webcraft/core`.
 */
export const VERSION_HEADER = "webcraft-version";
