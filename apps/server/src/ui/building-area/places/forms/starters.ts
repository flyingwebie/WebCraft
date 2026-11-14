import { emptyField, type FormField, type FormFieldType } from "@webcraft/renderer/forms";

import type { Words } from "../../api.ts";

/**
 * What New Form starts from (SPEC 15.2, `forms-builder/06`): a blank Form, or a starter's fields,
 * labelled in the person's Admin language (Staff change them, and translate them, as any field).
 */

export const STARTERS = ["blank", "contact", "booking", "newsletter", "job"] as const;

export type Starter = (typeof STARTERS)[number];

type Part = {
	key: string;
	type: FormFieldType;
	label: keyof Words["forms"]["starterFields"];
	required?: boolean;
	width?: "half" | "third";
	accept?: FormField["accept"];
};

const PARTS: Record<Starter, readonly Part[]> = {
	blank: [],
	contact: [
		{ key: "name", type: "text", label: "name", required: true, width: "half" },
		{ key: "email", type: "email", label: "email", required: true, width: "half" },
		{ key: "message", type: "textarea", label: "message", required: true },
	],
	booking: [
		{ key: "name", type: "text", label: "name", required: true, width: "half" },
		{ key: "email", type: "email", label: "email", required: true, width: "half" },
		{ key: "phone", type: "phone", label: "phone", width: "half" },
		{ key: "date", type: "date", label: "date", required: true, width: "half" },
		{ key: "people", type: "number", label: "people", required: true },
		{ key: "message", type: "textarea", label: "anythingElse" },
	],
	newsletter: [
		{ key: "email", type: "email", label: "email", required: true },
		{ key: "consent", type: "consent", label: "newsletterConsent", required: true },
	],
	job: [
		{ key: "name", type: "text", label: "name", required: true, width: "half" },
		{ key: "email", type: "email", label: "email", required: true, width: "half" },
		{ key: "phone", type: "phone", label: "phone" },
		{ key: "role", type: "text", label: "role", required: true },
		{ key: "cv", type: "file", label: "cv", required: true, accept: ["pdf", "docx", "odt"] },
		{ key: "message", type: "textarea", label: "coverLetter" },
	],
};

/** A starter's fields, labelled in `words`' language. */
export function starterFields(starter: Starter, words: Words): FormField[] {
	return PARTS[starter].map((part) => {
		const field = emptyField(part.key, part.type, { text: words.forms.starterFields[part.label] });
		if (part.required) field.required = true;
		if (part.width) field.width = part.width;
		if (part.accept) field.accept = [...part.accept];
		return field;
	});
}
