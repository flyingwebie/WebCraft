// The admin's text comes from one message file per Admin language. Every language the admin ships
// must say everything English says, with the same placeholders, in valid message syntax.
import { describe, expect, test } from "bun:test";
import { ADMIN_LANGUAGES } from "@webcraft/core";
import { SETTING_RULES } from "@webcraft/core/field-rules";
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

/**
 * The names of a message's arguments, in ICU message syntax: `{name}`, `{name, number}`, and those
 * of `select` and `plural`, whose branches are messages of their own (`{kind, select, prop {A Prop}
 * other {A Field}}` has one argument, `kind`, whatever words each language puts in its branches).
 */
function placeholders(message: string): string[] {
	const names: string[] = [];
	let at = 0;
	const skipSpace = () => {
		while (/\s/.test(message[at] ?? "")) at++;
	};
	const word = () => {
		const start = at;
		while (/[\w=]/.test(message[at] ?? "")) at++;
		return message.slice(start, at);
	};
	/** Reads message text up to the `}` closing it (a branch) or the end; `{` starts an argument. */
	const text = () => {
		while (at < message.length && message[at] !== "}") {
			if (message[at] === "{") {
				at++;
				argument();
			} else {
				at++;
			}
		}
	};
	/** Reads an argument after its `{`, up to and past its `}`. */
	const argument = () => {
		skipSpace();
		names.push(word());
		skipSpace();
		if (message[at] === ",") {
			at++;
			skipSpace();
			const type = word();
			skipSpace();
			if (type === "select" || type === "plural" || type === "selectordinal") {
				if (message[at] === ",") at++;
				for (;;) {
					skipSpace();
					if (message[at] === "}" || at >= message.length) break;
					word();
					skipSpace();
					if (message[at] !== "{") break;
					at++;
					text();
					at++;
				}
			} else {
				while (at < message.length && message[at] !== "}") at++;
			}
		}
		if (message[at] === "}") at++;
	};
	text();
	return names.sort();
}

const english = flatten(await load("en"));

test("every reason a setting can be refused has its wording", () => {
	const missing = SETTING_RULES.filter((rule) => !english.has(`content.settingProblems.${rule}`));
	expect(missing).toEqual([]);
	const extra = [...english.keys()]
		.filter((key) => key.startsWith("content.settingProblems."))
		.filter((key) => !(SETTING_RULES as readonly string[]).includes(key.slice("content.settingProblems.".length)));
	expect(extra).toEqual([]);
});

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
