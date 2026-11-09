import type { ApiClient } from "@webcraft/api";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import type { ReactNode } from "react";

import { type MessageKey, useT } from "../i18n.tsx";

/** A Module as the Install's Modules screen lists it. */
export type ModuleView = Awaited<ReturnType<ApiClient["modules"]["list"]>>["modules"][number];

const ROLE_KEYS = {
	staff: "modules.roles.staff",
	owner: "modules.roles.owner",
	editor: "modules.roles.editor",
	author: "modules.roles.author",
} as const satisfies Record<string, MessageKey>;

const CATEGORY_KEYS = {
	necessary: "modules.categories.necessary",
	analytics: "modules.categories.analytics",
	marketing: "modules.categories.marketing",
	media: "modules.categories.media",
} as const satisfies Record<string, MessageKey>;

const EVENT_KEYS = {
	"entry.published": "modules.events.entryPublished",
	"entry.deleted": "modules.events.entryDeleted",
	"template.published": "modules.events.templatePublished",
	"globals.published": "modules.events.globalsPublished",
	"form.submitted": "modules.events.formSubmitted",
	"paths.changed": "modules.events.pathsChanged",
} as const satisfies Record<string, MessageKey>;

/** `a`, `a and b`, `a, b and c`: the same on the server and in the browser, so hydration matches. */
function joinWords(words: readonly string[], and: string): string {
	if (words.length <= 1) return words.join("");
	return `${words.slice(0, -1).join(", ")} ${and} ${words.at(-1)}`;
}

/**
 * What a Module asks for and what it adds, in plain words: WebCraft's own wording for every grant,
 * so a Module can't describe what it asks for in its own terms. Items an update adds are marked new.
 */
export function ConsentDetails({ module, headingLevel = 3 }: { module: ModuleView; headingLevel?: 2 | 3 }) {
	const t = useT();
	const and = t("modules.and");
	const { asks, adds } = module;
	const showNew = module.status === "update-waiting";
	const Heading = headingLevel === 2 ? "h2" : "h3";

	const asked: { key: string; text: string; isNew: boolean }[] = [
		...asks.permissions.map((permission) => ({
			key: `permission:${permission.key}`,
			text:
				permission.roles.length === 0
					? t("modules.consent.permissionSuperadminOnly", { label: permission.label })
					: t("modules.consent.permission", {
							roles: joinWords(
								[
									t("modules.consent.superadmin"),
									...permission.roles.map((role) =>
										t(ROLE_KEYS[role as keyof typeof ROLE_KEYS] ?? "modules.roles.staff"),
									),
								],
								and,
							),
							label: permission.label,
						}),
			isNew: permission.isNew,
		})),
		...asks.uses.map((use) => ({ key: `use:${use.use}`, text: t("modules.consent.useEmail"), isNew: use.isNew })),
		...asks.outsideHosts.map((host) => ({
			key: `host:${host.host}`,
			text: t("modules.consent.host", { host: host.host }),
			isNew: host.isNew,
		})),
		...(asks.siteScript
			? [
					{
						key: "script",
						text: t(
							asks.siteScript.beforeConsent ? "modules.consent.siteScriptBeforeConsent" : "modules.consent.siteScript",
							{
								category: t(
									CATEGORY_KEYS[asks.siteScript.category as keyof typeof CATEGORY_KEYS] ??
										"modules.categories.necessary",
								),
							},
						),
						isNew: asks.siteScript.isNew,
					},
				]
			: []),
	];

	const added: string[] = [
		...(adds.siteRoutes ? [t("modules.consent.siteRoutes", { path: adds.siteRoutes })] : []),
		...(adds.adminPages.length > 0
			? [t("modules.consent.adminPages", { pages: joinWords(adds.adminPages, and) })]
			: []),
		...(adds.tables > 0 ? [t("modules.consent.tables", { level: module.level })] : []),
		...module.partitions.map((partition) =>
			t("modules.consent.partitions", { label: partition.label, months: partition.keepMonths }),
		),
		...(adds.components.length > 0
			? [t("modules.consent.components", { names: joinWords(adds.components, and) })]
			: []),
		...(adds.submissions ? [t("modules.consent.submissions")] : []),
		...(adds.redirectRules ? [t("modules.consent.redirectRules")] : []),
		...(adds.notFoundLog ? [t("modules.consent.notFoundLog")] : []),
		...(adds.importSources.length > 0
			? [t("modules.consent.importSources", { sources: joinWords(adds.importSources, and) })]
			: []),
		...[...new Set(adds.schedules)].map((every) => t("modules.consent.schedule", { every })),
		...(adds.events.length > 0
			? [
					t("modules.consent.events", {
						events: joinWords(
							adds.events.map((event) =>
								t(EVENT_KEYS[event as keyof typeof EVENT_KEYS] ?? "modules.events.entryPublished"),
							),
							t("modules.and"),
						),
					}),
				]
			: []),
	];

	return (
		<div className="grid gap-5">
			<Section heading={<Heading className="font-medium">{t("modules.consent.asks")}</Heading>}>
				{asked.length === 0 ? (
					<p className="text-muted-foreground">{t("modules.consent.asksNothing")}</p>
				) : (
					<ul className="grid list-disc gap-1.5 ps-5">
						{asked.map((item) => (
							<li key={item.key}>
								{item.text}
								{showNew && item.isNew ? (
									<Badge variant="secondary" className="ms-2 align-middle">
										{t("modules.consent.new")}
									</Badge>
								) : null}
							</li>
						))}
					</ul>
				)}
			</Section>
			<Section heading={<Heading className="font-medium">{t("modules.consent.adds")}</Heading>}>
				{added.length === 0 ? (
					<p className="text-muted-foreground">{t("modules.consent.addsNothing")}</p>
				) : (
					<ul className="grid list-disc gap-1.5 ps-5">
						{added.map((text) => (
							<li key={text}>{text}</li>
						))}
					</ul>
				)}
			</Section>
			<Section heading={<Heading className="font-medium">{t("modules.consent.where")}</Heading>}>
				<p>
					{module.onByDefault
						? t("modules.consent.onByDefault", { level: module.level })
						: t("modules.consent.offByDefault", { level: module.level })}
				</p>
			</Section>
		</div>
	);
}

function Section({ heading, children }: { heading: ReactNode; children: ReactNode }) {
	return (
		<section className="grid gap-2">
			{heading}
			{children}
		</section>
	);
}
