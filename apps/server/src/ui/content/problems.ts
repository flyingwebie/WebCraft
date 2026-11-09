import {
	FIELD_TYPES,
	type FieldType,
	SETTING_RULES,
	type SettingRule,
	VALUE_RULES,
	type ValueRule,
} from "@webcraft/core/field-rules";
import { isBlockType } from "@webcraft/renderer/body";

import type { useT } from "../i18n.tsx";
import { type FieldDefinition, fieldAtPath, type Problem } from "./model.ts";

type Translate = ReturnType<typeof useT>;

/** What a problem is about: a Field, or one of the built-in values every Entry has. */
export type ProblemSubject = FieldDefinition | "title" | "slug" | "parentId" | null;

function isRule(rule: string | undefined): rule is ValueRule {
	return (VALUE_RULES as readonly string[]).includes(rule ?? "");
}

/**
 * A problem in the person's Admin language. Broken rules are worded from their `rule` code and the
 * Field's settings (`At least 3 rows.`); values refused for being the wrong kind (no rule) are worded
 * by what they are (a slug, a link, a Relationship).
 */
export function problemText(t: Translate, problem: Problem, subject: ProblemSubject): string {
	const field = subject && typeof subject === "object" ? subject : null;
	if (!isRule(problem.rule)) return refusedText(t, problem, subject);
	const rule = problem.rule;
	switch (rule) {
		case "required":
			return t("content.problems.required");
		case "minLength":
			return t("content.problems.minLength", { count: settingNumber(field, "minLength") });
		case "maxLength":
			return field?.type === "richText"
				? t("content.problems.maxRichTextLength", { count: settingNumber(field, "maxLength") })
				: t("content.problems.maxLength", { count: settingNumber(field, "maxLength") });
		case "min":
		case "max":
			return boundText(t, rule, field);
		case "pattern":
		case "integer":
		case "email":
		case "options":
		case "url":
		case "postTypes":
		case "media":
		case "blockType":
		case "video":
			return t(`content.problems.${rule}`);
	}
}

/** Too few, too many, too small or too large, worded for what the Field holds. */
function boundText(t: Translate, rule: "min" | "max", field: FieldDefinition | null): string {
	const bound = field && "min" in field ? (rule === "min" ? field.min : field.max) : null;
	switch (field?.type) {
		case "number":
			return t(rule === "min" ? "content.problems.minNumber" : "content.problems.maxNumber", {
				value: String(bound ?? ""),
			});
		case "date":
			return t(rule === "min" ? "content.problems.minDate" : "content.problems.maxDate", {
				value: String(bound ?? ""),
			});
		case "select":
			return t(rule === "min" ? "content.problems.minChoices" : "content.problems.maxChoices", {
				count: Number(bound ?? 0),
			});
		case "relationship":
			return t(rule === "min" ? "content.problems.minEntries" : "content.problems.maxEntries", {
				count: Number(bound ?? 0),
			});
		case "repeater":
			return t(rule === "min" ? "content.problems.minRows" : "content.problems.maxRows", {
				count: Number(bound ?? 0),
			});
		default:
			return t("content.problems.invalid");
	}
}

function settingNumber(field: FieldDefinition | null, setting: "minLength" | "maxLength"): number {
	const value = field && setting in field ? (field as Record<string, unknown>)[setting] : null;
	return typeof value === "number" ? value : 0;
}

function isFieldType(type: string): type is FieldType {
	return (FIELD_TYPES as readonly string[]).includes(type);
}

function isSettingRule(rule: string | undefined): rule is SettingRule {
	return (SETTING_RULES as readonly string[]).includes(rule ?? "");
}

/**
 * A refused setting of a Post Type, a Field or the Globals, in the person's Admin language, worded
 * from its `rule` code and `params`. A problem without a known code (from a newer server) keeps the
 * English the server sent.
 */
export function settingProblemText(t: Translate, problem: Problem): string {
	if (!isSettingRule(problem.rule)) return problem.message;
	const params: Record<string, string | number> = { ...problem.params };
	// Field and Block types by their names in the Admin language, not their ids.
	const type = params.type;
	if (problem.rule === "typeChanged" && typeof type === "string" && isFieldType(type)) {
		params.type = t(`content.types.${type}`);
	}
	if (problem.rule === "blockAlwaysOn" && typeof type === "string" && isBlockType(type)) {
		params.type = t(`body.types.${type}`);
	}
	return t(`content.settingProblems.${problem.rule}`, params);
}

/** A value refused when it was saved: the wrong kind for its Field. */
function refusedText(t: Translate, problem: Problem, subject: ProblemSubject): string {
	if (subject === "slug") return t("content.problems.slugShape");
	if (subject === "parentId") return t("content.problems.parent");
	if (subject && typeof subject === "object") {
		switch (subject.type) {
			case "link":
				return t("content.problems.linkAddress");
			case "relationship":
				return t("content.problems.entryGone");
			case "media":
				return t("content.problems.fileGone");
			case "date":
				return t("content.problems.dateShape");
			default:
				break;
		}
	}
	return problem.at.endsWith(".id") ? t("content.problems.row") : t("content.problems.invalid");
}

/** What a problem's path names, for an Entry (or the Globals): a built-in value or a Field. */
export function subjectOf(fields: readonly FieldDefinition[], at: string): ProblemSubject {
	if (at === "title" || at === "slug" || at === "parentId") return at;
	return fieldAtPath(fields, at)?.field ?? null;
}

/** Where a problem is, in words: `Title`, `Recipe › Prep time`, `Steps, row 2 › Step text`. */
export function problemPlace(t: Translate, fields: readonly FieldDefinition[], at: string): string {
	if (at === "title") return t("content.builtIn.title");
	if (at === "slug") return t("content.builtIn.slug");
	if (at === "parentId") return t("content.builtIn.parent");
	const found = fieldAtPath(fields, at);
	if (!found) return t("content.problems.elsewhere");
	// A Body field's `[n]` is one of its Blocks, not a Repeater's row.
	const blocks = found.field.type === "body";
	return found.trail
		.map((part, index) => {
			if (!part.row) return part.label;
			return blocks && index === found.trail.length - 1
				? t("content.problems.inBlock", { label: part.label, block: part.row })
				: t("content.problems.inRow", { label: part.label, row: part.row });
		})
		.join(" › ");
}
