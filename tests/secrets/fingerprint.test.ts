// The Master key fingerprint: a one-way value that identifies a key without revealing it. Backup
// manifests carry it and restore compares it with the running Install's key (ADR 0032), so its
// value for a given key must never change between versions.
import { describe, expect, test } from "bun:test";
import { parseMasterKey } from "@webcraft/core";

const KEY = "known-answer-master-key-for-the-fingerprint";

const fingerprintOf = (key: string) => parseMasterKey(key, "WEBCRAFT_SECRET_KEY").fingerprint();

describe("the Master key fingerprint", () => {
	test("is HKDF-SHA256 of the key, as 64 hexadecimal characters, and never changes for a key", async () => {
		// Worked out once with Node's own HKDF: salt "webcraft master key", info
		// "webcraft master key fingerprint", 32 bytes.
		expect(await fingerprintOf(KEY)).toBe("08e5bf6005b1a469f66a4c66f76d11cf287f457d626b53abfe3f27c2a1e40cc6");
	});

	test("is the same for the same key, whitespace around it aside, and different for another key", async () => {
		expect(await fingerprintOf(`  ${KEY}\n`)).toBe(await fingerprintOf(KEY));
		expect(await fingerprintOf(`${KEY}!`)).not.toBe(await fingerprintOf(KEY));
	});

	test("holds nothing of the key", async () => {
		const fingerprint = await fingerprintOf(KEY);

		expect(fingerprint).not.toContain(KEY);
		expect(fingerprint).not.toContain(Buffer.from(KEY).toString("hex").slice(0, 16));
	});

	test("a Master key shows as a placeholder, never as the key, when printed or turned into JSON", () => {
		const key = parseMasterKey(KEY, "WEBCRAFT_SECRET_KEY");

		expect(JSON.stringify({ key })).toBe('{"key":"[Master key]"}');
		expect(`${key}`).toBe("[Master key]");
		expect(Bun.inspect(key)).not.toContain(KEY);
	});
});
