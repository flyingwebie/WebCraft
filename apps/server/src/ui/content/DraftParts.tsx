import { Link, type LinkProps } from "@tanstack/react-router";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { CircleAlertIcon, CircleCheckIcon, LoaderIcon } from "lucide-react";

import { formatUtc } from "../format.ts";
import { useT } from "../i18n.tsx";
import type { AutosaveStatus } from "./autosave.ts";
import { controlId, type FieldDefinition, type Problem } from "./model.ts";
import { problemPlace, problemText, subjectOf } from "./problems.ts";

/** Where an Entry (or the Globals) stands for visitors: never published, published, or changed since. */
export function StatusBadge({ status }: { status: "draft" | "published" | "changed" }) {
	const t = useT();
	const variant = status === "published" ? "secondary" : status === "changed" ? "default" : "outline";
	return <Badge variant={variant}>{t(`entries.status.${status}`)}</Badge>;
}

/** Whether the Draft is saved, being saved, or failed to save; for screen readers too, politely. */
export function SaveStatusText({ status, savedAt }: { status: AutosaveStatus; savedAt: Date | string | null }) {
	const t = useT();
	return (
		<span role="status" className="inline-flex items-center gap-1.5">
			{status === "saving" || status === "waiting" ? (
				<>
					<LoaderIcon className="size-3.5 animate-spin" aria-hidden="true" />
					{t("entries.editor.saving")}
				</>
			) : status === "failed" ? (
				<>
					<CircleAlertIcon className="text-destructive size-3.5" aria-hidden="true" />
					{t("entries.editor.notSaved")}
				</>
			) : savedAt ? (
				<>
					<CircleCheckIcon className="size-3.5" aria-hidden="true" />
					{t("entries.editor.savedAt", { time: formatUtc(savedAt) })}
				</>
			) : null}
		</span>
	);
}

/**
 * What keeps a Draft from being published, in the person's language, each a button that moves focus
 * to the value it is about.
 */
export function ProblemSummary({
	problems,
	fields,
	idPrefix,
	headingId,
}: {
	problems: readonly Problem[];
	fields: readonly FieldDefinition[];
	idPrefix: string;
	headingId: string;
}) {
	const t = useT();
	if (problems.length === 0) return null;
	return (
		<div className="grid gap-2 text-sm">
			<p id={headingId} className="text-destructive flex items-center gap-2 font-medium">
				<CircleAlertIcon className="size-4" aria-hidden="true" />
				{t("entries.editor.toFix", { count: problems.length })}
			</p>
			<ul aria-labelledby={headingId} className="grid gap-1">
				{problems.map((problem) => (
					<li key={`${problem.at}:${problem.rule ?? problem.message}`}>
						<button
							type="button"
							className="focus-visible:ring-ring/50 rounded-sm text-start underline underline-offset-4 outline-none focus-visible:ring-3"
							onClick={() => document.getElementById(controlId(idPrefix, problem.at))?.focus()}
						>
							{problemPlace(t, fields, problem.at)}: {problemText(t, problem, subjectOf(fields, problem.at))}
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * The languages a Draft is written in, as tabs: each opens the same Draft in that language, the
 * Site's languages with the Default language first.
 */
export function LanguageTabs({
	languages,
	current,
	link,
}: {
	languages: { default: string; all: readonly string[] };
	current: string;
	link(language: string): LinkProps;
}) {
	const t = useT();
	return (
		<nav aria-label={t("entries.editor.languages")} className="border-b">
			<ul className="-mb-px flex flex-wrap gap-4">
				{languages.all.map((language) => (
					<li key={language}>
						<Link
							{...link(language)}
							aria-current={language === current ? "page" : undefined}
							className="focus-visible:ring-ring/50 aria-[current=page]:border-primary aria-[current=page]:text-foreground text-muted-foreground flex items-center gap-2 rounded-t-sm border-b-2 border-transparent px-1 pb-2 text-sm font-medium outline-none focus-visible:ring-3"
						>
							<span lang={language}>{languageName(language)}</span>
							{language === languages.default ? <Badge variant="outline">{t("entries.editor.default")}</Badge> : null}
						</Link>
					</li>
				))}
			</ul>
		</nav>
	);
}

/** A language's own name (`English`, `Italiano`), or its tag when the runtime doesn't know it. */
export function languageName(language: string): string {
	try {
		const name = new Intl.DisplayNames([language], { type: "language" }).of(language);
		return name ? name.charAt(0).toLocaleUpperCase(language) + name.slice(1) : language;
	} catch {
		return language;
	}
}
