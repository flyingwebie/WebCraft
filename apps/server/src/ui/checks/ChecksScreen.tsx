import type { SiteCheck } from "@webcraft/core";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@webcraft/ui/components/input-group.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import {
	AccessibilityIcon,
	ContrastIcon,
	FileTextIcon,
	HeadingIcon,
	ImageIcon,
	ImageOffIcon,
	LanguagesIcon,
	LinkIcon,
	type LucideIcon,
	MousePointerClickIcon,
	PanelTopIcon,
	SearchCheckIcon,
	SearchIcon,
	SmartphoneIcon,
	SpellCheckIcon,
	TableIcon,
	VideoIcon,
} from "lucide-react";
import { useId, useMemo, useState } from "react";

import { languageName } from "../content/DraftParts.tsx";
import { Segmented } from "../filters/Segmented.tsx";
import { type MessageKey, useT } from "../i18n.tsx";
import type { PlacePostType } from "../shell/levels.ts";
import { PageHeader } from "../shell/page.tsx";

/** One open Check, as `checks.list` answers it. */
type Check = Omit<SiteCheck, "componentId">;

/** The kinds the screen counts and groups Checks by. */
const KINDS = ["accessibility", "search", "words"] as const;
type Kind = (typeof KINDS)[number];

const KIND_ICONS: Record<Kind, LucideIcon> = {
	accessibility: AccessibilityIcon,
	search: SearchIcon,
	words: SpellCheckIcon,
};

/** Which kind a Check is: what search engines read, the words of links and buttons, or accessibility. */
function kindOf(check: string): Kind {
	if (check.startsWith("seo") || check === "missingH1" || check === "multipleH1") return "search";
	if (check === "vagueLink" || check === "vagueButton") return "words";
	return "accessibility";
}

/** The icon beside a Check: what it is about. */
function iconOf(check: string): LucideIcon {
	switch (check) {
		case "missingAlt":
			return ImageOffIcon;
		case "contrast":
			return ContrastIcon;
		case "missingH1":
		case "multipleH1":
		case "skippedHeading":
			return HeadingIcon;
		case "seoImageMissing":
		case "seoImageAlt":
			return ImageIcon;
		case "vagueLink":
			return LinkIcon;
		case "vagueButton":
		case "emptyButton":
			return MousePointerClickIcon;
		case "missingMain":
		case "multipleMain":
			return PanelTopIcon;
		case "missingLanguage":
			return LanguagesIcon;
		case "tableHeader":
			return TableIcon;
		case "untitledVideo":
			return VideoIcon;
		case "popupPhoneEarly":
			return SmartphoneIcon;
		default:
			return check.startsWith("seo") ? FileTextIcon : SearchCheckIcon;
	}
}

/**
 * Site › Checks (frame "Checks"): how many are open by kind, as tiles; a filter by kind and a search;
 * then the open Checks in groups, each with what is wrong in plain words, where it is, and Open, which
 * goes to that spot (the editor, or the builder for Structure). Checks are advice: they never stop
 * publishing. The app keeps no record of when a Check appeared, nor a way to ignore one: a Check goes
 * when what it is about is fixed.
 */
export function ChecksScreen({
	checks,
	postTypes,
}: {
	checks: readonly Check[];
	/** The Site's Post Types, to say what kind of Entry a Check is on. */
	postTypes: readonly PlacePostType[];
}) {
	const t = useT();
	const id = useId();
	const [kind, setKind] = useState<Kind | "all">("all");
	const [query, setQuery] = useState("");
	const languages = useMemo(() => new Set(checks.map((check) => check.language)), [checks]);
	const rows = useMemo(
		() =>
			checks.map((check) => ({
				check,
				kind: kindOf(check.check),
				message: messageOf(t, check),
				where: whereOf(t, check, postTypes, languages.size > 1),
			})),
		[checks, t, postTypes, languages],
	);
	const counts = Object.fromEntries(
		KINDS.map((each) => [each, rows.filter((row) => row.kind === each).length]),
	) as Record<Kind, number>;
	const words = query.trim().toLocaleLowerCase();
	const shown = rows.filter(
		(row) =>
			(kind === "all" || row.kind === kind) &&
			(!words || `${row.message} ${row.where}`.toLocaleLowerCase().includes(words)),
	);

	return (
		<>
			<PageHeader heading={t("checks.heading")}>{t("checks.screen.description")}</PageHeader>
			<div className="grid gap-6">
				<ul aria-label={t("checks.screen.counts")} className="grid gap-4 @2xl/page:grid-cols-3">
					{KINDS.map((each) => {
						const Icon = KIND_ICONS[each];
						return (
							<li
								key={each}
								className="bg-card ring-foreground/10 flex items-center gap-3 rounded-xl p-4 shadow-xs ring-1"
							>
								<span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
									<Icon aria-hidden="true" className="size-[18px]" />
								</span>
								<span className="grid gap-0.5">
									<span className="text-xl font-semibold tabular-nums">{counts[each]}</span>
									<span className="text-muted-foreground text-[13px]">{t(`checks.screen.kinds.${each}`)}</span>
								</span>
							</li>
						);
					})}
				</ul>

				<div className="flex flex-wrap items-center gap-3">
					<Segmented<Kind | "all">
						label={t("checks.screen.filter")}
						size="sm"
						value={kind}
						options={[
							{ value: "all", label: t("checks.screen.all", { count: rows.length }) },
							...KINDS.map((each) => ({
								value: each,
								label: t("checks.screen.kindCount", { kind: t(`checks.screen.kinds.${each}`), count: counts[each] }),
							})),
						]}
						onChange={setKind}
					/>
					<div className="ms-auto w-full max-w-[260px]">
						<Label htmlFor={`${id}-search`} className="sr-only">
							{t("checks.screen.search")}
						</Label>
						<InputGroup>
							<InputGroupAddon>
								<SearchIcon aria-hidden="true" />
							</InputGroupAddon>
							<InputGroupInput
								id={`${id}-search`}
								type="search"
								placeholder={t("checks.screen.search")}
								value={query}
								onChange={(event) => setQuery(event.target.value)}
							/>
						</InputGroup>
					</div>
				</div>

				{rows.length === 0 ? (
					<p className="text-muted-foreground rounded-xl border p-6 text-sm">{t("checks.empty")}</p>
				) : shown.length === 0 ? (
					<p role="status" className="text-muted-foreground rounded-xl border p-6 text-sm">
						{t("checks.screen.noneFound")}
					</p>
				) : (
					<div className="grid gap-5">
						{KINDS.map((each) => {
							const listed = shown.filter((row) => row.kind === each);
							if (listed.length === 0) return null;
							return (
								<section key={each} aria-labelledby={`${id}-${each}`} className="grid gap-2">
									<h2 id={`${id}-${each}`} className="flex h-8 items-center gap-2 px-1 text-[13px] font-semibold">
										{t(`checks.screen.kinds.${each}`)}
										<Badge variant="outline" className="tabular-nums">
											{listed.length}
										</Badge>
									</h2>
									<ul className="bg-background divide-y overflow-hidden rounded-xl border">
										{listed.map(({ check, message, where }) => {
											const Icon = iconOf(check.check);
											const rowId = `${id}-${keyOf(check)}`;
											return (
												<li key={keyOf(check)} className="flex items-center gap-3 px-4 py-3.5">
													<Icon aria-hidden="true" className="text-muted-foreground size-[18px] shrink-0" />
													<div className="grid min-w-0 flex-1 gap-0.5">
														<p id={rowId} className="text-sm font-medium">
															{message}
														</p>
														<p className="text-muted-foreground text-[13px]">{where}</p>
													</div>
													{check.href ? (
														<Button
															variant="outline"
															size="sm"
															aria-describedby={rowId}
															// The editor, or the builder for Structure: both are pages of their own.
															render={<a href={check.href} />}
														>
															{t("checks.screen.open")}
														</Button>
													) : null}
												</li>
											);
										})}
									</ul>
								</section>
							);
						})}
					</div>
				)}
				<p className="text-muted-foreground text-xs">{t("checks.intro")}</p>
			</div>
		</>
	);
}

type Translate = ReturnType<typeof useT>;

function keyOf(check: Check): string {
	return `${check.item.kind}-${check.item.id}-${check.language}-${check.check}-${check.at}-${check.detail ?? ""}`;
}

/** What is wrong, in plain words. */
function messageOf(t: Translate, check: Check): string {
	const key = `${check.check.startsWith("seo") ? "seo.checks" : "checks"}.${check.check}` as MessageKey;
	return t(key, check.params ?? {});
}

/**
 * Where it is: what the item is (an Entry's Post Type, a Template's kind, a Component, the Design
 * system, a Popup), its name, the language when the Site has several, and the detail the Check gives
 * (a colour pair).
 */
function whereOf(t: Translate, check: Check, postTypes: readonly PlacePostType[], languages: boolean): string {
	const { item } = check;
	const parts: string[] = [];
	switch (item.kind) {
		case "entry": {
			const postTypeId = /\/entries\/([^/?#]+)\//.exec(check.href)?.[1];
			const postType = postTypes.find((each) => each.id === postTypeId);
			parts.push(
				postType?.builtIn === "page"
					? t("checks.screen.items.page")
					: (postType?.name ?? t("checks.screen.items.entry")),
			);
			parts.push(item.name || t("publishAll.untitled"));
			break;
		}
		case "template":
			parts.push(t(`checks.items.${item.templateKind ?? "site"}` as MessageKey));
			if (item.name) parts.push(item.name);
			break;
		case "component":
			parts.push(t("checks.screen.items.component"), item.name);
			break;
		case "popup":
			parts.push(t("checks.screen.items.popup"), item.name);
			break;
		case "designSystem":
			parts.push(t("checks.items.designSystem"));
			break;
	}
	if (check.detail) parts.push(check.detail);
	if (languages) parts.push(languageName(check.language));
	return parts.join(" · ");
}
