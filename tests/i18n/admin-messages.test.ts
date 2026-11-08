// The admin's text comes from one message file per Admin language. Every language the admin ships
// must say everything English says, with the same placeholders, in valid message syntax.
import { describe, expect, test } from "bun:test";
import { ADMIN_LANGUAGES } from "@webcraft/core";
import { createTranslator } from "use-intl/core";

const MESSAGES = new URL("../../apps/server/src/messages/", import.meta.url);

type Messages = { [key: string]: string | Messages };

async function load(code: string): Promise<Messages> {
	return Bun.file(new URL(`${code}.json`, MESSAGES)).json();
}

/** Every message by its dotted key. */
function flatten(messages: Messages, prefix = ""): Map<string, string> {
	const flat = new Map<string, string>();
	for (const [key, value] of Object.entries(messages)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (typeof value === "string") flat.set(path, value);
		else for (const [nested, text] of flatten(value, path)) flat.set(nested, text);
	}
	return flat;
}

function placeholders(message: string): string[] {
	return [...message.matchAll(/\{\s*(\w+)/g)].map((match) => match[1] ?? "").sort();
}

const english = flatten(await load("en"));

describe("admin message files", () => {
	for (const { code } of ADMIN_LANGUAGES) {
		test(`${code} has every message English has, and nothing else`, async () => {
			const messages = flatten(await load(code));

			expect([...messages.keys()].sort()).toEqual([...english.keys()].sort());
		});

		test(`${code} uses the same placeholders as English in every message`, async () => {
			const messages = flatten(await load(code));

			for (const [key, text] of english) {
				expect({ key, placeholders: placeholders(messages.get(key) ?? "") }).toEqual({
					key,
					placeholders: placeholders(text),
				});
			}
		});

		test(`every ${code} message can be shown`, async () => {
			const raw = await load(code);
			const errors: string[] = [];
			const t = createTranslator({ locale: code, messages: raw, onError: (error) => errors.push(error.message) });

			for (const [key, text] of flatten(raw)) {
				const values = Object.fromEntries(placeholders(text).map((name) => [name, "x"]));
				// biome-ignore lint/suspicious/noExplicitAny: keys come from the file being checked.
				expect((t as any)(key, values)).not.toBe(key);
			}
			expect(errors).toEqual([]);
		});
	}
});
