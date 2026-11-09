import {
	FIELD_HELP_MAX_LENGTH,
	FIELD_LABEL_MAX_LENGTH,
	FIELD_TYPES,
	type FieldInput,
	MAX_FIELDS,
} from "@webcraft/core";
import { z } from "zod";

/**
 * A Field as Staff define it, for a Post Type or the Globals. The input is checked loosely here, as
 * a shape; the server checks every setting against its Field type and answers each problem where it
 * is (`fields[2].options[1].value`).
 */
export const fieldInput: z.ZodType<FieldInput, FieldInput> = z.lazy(() =>
	z.object({
		key: z.string().max(100),
		label: z.string().max(FIELD_LABEL_MAX_LENGTH * 2),
		type: z.enum(FIELD_TYPES),
		help: z
			.string()
			.max(FIELD_HELP_MAX_LENGTH * 2)
			.optional(),
		required: z.boolean().optional(),
		translatable: z.boolean().optional(),
		default: z.unknown().optional(),
		minLength: z.number().nullable().optional(),
		maxLength: z.number().nullable().optional(),
		pattern: z.string().max(1_000).nullable().optional(),
		min: z
			.union([z.number(), z.string().max(100)])
			.nullable()
			.optional(),
		max: z
			.union([z.number(), z.string().max(100)])
			.nullable()
			.optional(),
		integer: z.boolean().optional(),
		mode: z.string().max(20).optional(),
		options: z
			.array(z.object({ value: z.string().max(200), label: z.string().max(FIELD_LABEL_MAX_LENGTH * 2) }))
			.max(1_000)
			.optional(),
		multiple: z.boolean().optional(),
		postTypes: z.array(z.string().max(100)).max(100).optional(),
		twoWay: z.boolean().optional(),
		blocksOff: z.array(z.string().max(100)).max(100).optional(),
		fields: z.array(fieldInput).max(MAX_FIELDS).optional(),
	}),
);

export const fieldInputs = z.array(fieldInput).max(MAX_FIELDS);

/** Field values by key, each as its Field type takes it; the server checks them against the Fields. */
export const fieldValues = z.record(z.string().max(100), z.unknown());

/** A language tag, such as `en`; the Site decides which it has. */
export const language = z.string().min(2).max(35);

/**
 * A change to an Entry's SEO fields: only those given change, null or "" clears one. The server checks
 * each (a canonical URL is an http or https address or a Site path; the social image an image of the
 * Site's Media library) and answers a wrong one at its path (`seo.canonical`).
 */
export const seoFields = z.object({
	title: z.string().max(4_000).nullable().optional(),
	description: z.string().max(4_000).nullable().optional(),
	canonical: z.string().max(4_000).nullable().optional(),
	image: z.string().max(100).nullable().optional(),
	noindex: z.boolean().nullable().optional(),
});
