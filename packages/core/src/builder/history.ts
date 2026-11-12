import { editorHistoryTransfers } from "@webcraft/db/schema";
import { and, eq, gt, lte } from "drizzle-orm";
import type { Json } from "../co-editing/document.ts";
import { HistoryObsolete, reverseChange } from "../co-editing/reverse.ts";
import { type CssTarget, classesCss, saveCss } from "../code-mode/css.ts";
import { getComponentScript, saveComponentScript } from "../content/component-scripts.ts";
import { getScript, saveScriptDraft } from "../content/scripts.ts";
import { personIdOf } from "../permissions/can.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { hashToken, newToken } from "../tokens.ts";

/** A single-use, person/Site-bound bridge between the two editor origins; never a persistent history. */
export async function transferHistory(scope: SiteScope, payload: string) {
	const token = newToken();
	const now = scope.now();
	await scope.delete(editorHistoryTransfers, lte(editorHistoryTransfers.expiresAt, now));
	await scope.insert(editorHistoryTransfers, {
		personId: personIdOf(scope.access.actor),
		tokenHash: await hashToken(token),
		payload,
		expiresAt: new Date(now.getTime() + 60_000),
	});
	return { token };
}
export async function claimHistory(scope: SiteScope, token: string) {
	return scope.transaction(async (scope) => {
		const [row] = await scope.db
			.delete(editorHistoryTransfers)
			.where(
				scope.where(
					editorHistoryTransfers,
					and(
						eq(editorHistoryTransfers.tokenHash, await hashToken(token)),
						eq(editorHistoryTransfers.personId, personIdOf(scope.access.actor) ?? ""),
						gt(editorHistoryTransfers.expiresAt, scope.now()),
					),
				),
			)
			.returning();
		return { payload: row?.payload ?? null };
	});
}

/** HTTP-only Drafts retain their normal optimistic versions and validation. No publish or Run. */
export async function reverseHttpHistory(scope: SiteScope, resource: string, from: Json, to: Json) {
	const [kind, siteId, which, id] = resource.split(":");
	if (siteId !== scope.site.id) return { ok: false as const, code: "HISTORY_OBSOLETE" };
	return scope
		.transaction(async (scope) => {
			let before: Json;
			let after: Json;
			if (kind === "css") {
				let target: CssTarget;
				try {
					target = JSON.parse(resource.slice(resource.indexOf(":", resource.indexOf(":") + 1) + 1)) as CssTarget;
					if (
						!target ||
						(target.kind !== "site" &&
							(target.kind !== "class" ||
								!/^[A-Za-z0-9_-]{1,64}$/.test(target.classId) ||
								!["styles", "css", "breakpoint"].includes(target.part) ||
								(target.part === "breakpoint" && !/^[A-Za-z0-9_-]{1,64}$/.test(target.breakpointId))))
					)
						throw new HistoryObsolete();
				} catch {
					return { ok: false as const, code: "HISTORY_OBSOLETE" };
				}
				const css = await classesCss(scope, target.kind === "class" ? [target.classId] : []);
				const each = target.kind === "class" ? css.classes.find((c) => c.id === target.classId) : null;
				if (target.kind === "class" && !each) return { ok: false as const, code: "HISTORY_OBSOLETE" };
				before =
					target.kind === "site"
						? css.siteCss.css
						: target.part === "breakpoint"
							? (each?.breakpoints[target.breakpointId] ?? "")
							: (each?.[target.part] ?? "");
				after = reverseChange(from, to, before);
				if (typeof after !== "string") return { ok: false as const, code: "HISTORY_OBSOLETE" };
				const stored = await saveCss(scope, {
					target,
					text: after,
					version: target.kind === "site" ? css.siteCss.version : (each?.version ?? null),
				});
				after = stored.text;
			} else if (kind === "script" && which === "component" && id) {
				const script = await getComponentScript(scope, id);
				before = (script?.draft ?? { code: "", consentCategory: "necessary", libraryIds: [] }) as unknown as Json;
				after = reverseChange(from, to, before);
				const stored = await saveComponentScript(
					scope,
					id,
					after as unknown as Parameters<typeof saveComponentScript>[2],
					{ basedOn: script?.version ?? null },
				);
				after = stored.draft as unknown as Json;
			} else if (kind === "script" && (which === "site" || which === "page")) {
				const entryId = which === "site" ? null : (id ?? "");
				const script = await getScript(scope, entryId);
				before = script?.draft ?? "";
				after = reverseChange(from, to, before);
				if (typeof after !== "string") return { ok: false as const, code: "HISTORY_OBSOLETE" };
				const stored = await saveScriptDraft(scope, entryId, after, { basedOn: script?.version ?? null });
				after = stored.draft;
			} else return { ok: false as const, code: "HISTORY_OBSOLETE" };
			return { ok: true as const, before, after };
		})
		.catch((error) => {
			if (error instanceof HistoryObsolete) return { ok: false as const, code: error.code };
			throw error;
		});
}
