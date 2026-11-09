import webcraftPackage from "../../../package.json" with { type: "json" };

/**
 * This build's WebCraft version: the `version` of the repository's root `package.json`, which a
 * release sets before it is tagged (`v<version>`). The migrate step records it, Backups carry it,
 * and the update check compares it with the newest release.
 */
export const WEBCRAFT_VERSION: string = webcraftPackage.version;
