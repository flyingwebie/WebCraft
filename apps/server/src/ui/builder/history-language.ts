import { errorMessage } from "../errors.ts";
import type { MessageKey, useT } from "../i18n.tsx";

type Translate = ReturnType<typeof useT>;
const actions = [
	["builder.layers.renamed", "rename"],
	["builder.moves.moved", "move"],
	["builder.moves.dropped", "move"],
	["builder.moves.deleted", "delete"],
	["builder.moves.cut", "cut"],
	["builder.moves.duplicated", "duplicate"],
	["builder.moves.pasted", "paste"],
	["builder.moves.inserted", "insert"],
	["builder.css.created", "createClass"],
	["builder.css.renamed", "rename"],
	["builder.commandMenu.wrapped", "wrap"],
	["builder.commandMenu.unwrapped", "unwrap"],
] as const;

/** Finished-action announcements and history labels share their translated subject. */
export function historyLanguage(t: Translate) {
	const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const patterns = actions.map(([source, action]) => ({
		action,
		pattern: new RegExp(
			`^${escapePattern(t(source, { name: "__NAME__", where: "__WHERE__", what: "__WHAT__" }).replace(/\.$/, ""))
				.replace("__NAME__", "(.+?)")
				.replace("__WHAT__", ".*")
				.replace("__WHERE__", ".*")}$`,
		),
	}));
	return {
		label(message: string) {
			const text = message.replace(/\.$/, "");
			for (const { action, pattern } of patterns) {
				const found = pattern.exec(text);
				if (found) return t(`editorHistory.${action}`, { name: found[1] ?? "" });
			}
			if (
				[t("builder.style.oneOffApplied"), t("builder.style.oneOffRemoved")].some(
					(each) => each.replace(/\.$/, "") === text,
				)
			)
				return t("editorHistory.oneOff");
			return text;
		},
		words(key: string, label: string, title?: string) {
			if (key === "on") return t("editorHistory.on", { message: label, title: title ?? "" });
			if (["undid", "redid", "skipped", "HISTORY_OBSOLETE", "HISTORY_UNAVAILABLE", "HISTORY_PARTIAL"].includes(key))
				return t(`editorHistory.${key}` as MessageKey, { label });
			return t(errorMessage({ code: key }));
		},
	};
}
