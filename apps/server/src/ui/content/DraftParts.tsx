import { Link, type LinkProps } from "@tanstack/react-router";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import { CircleAlertIcon, CircleCheckIcon, LoaderIcon, UploadIcon } from "lucide-react";
import { type ReactNode, type RefObject, useRef, useState } from "react";
import { useAfterRender } from "../after-render.ts";

import { errorCode, errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
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

/**
 * A Draft that failed to save: what went wrong and Try again, plus Reload when someone else changed
 * it meanwhile (`CHANGED_MEANWHILE`), since trying again can't help then.
 */
export function SaveErrorBanner({ error, onRetry }: { error: MessageKey; onRetry: () => void }) {
	const t = useT();
	return (
		<div
			role="alert"
			className="border-destructive/50 text-destructive flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm"
		>
			<CircleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
			<span className="flex-1">{t(error)}</span>
			<Button type="button" size="sm" variant="outline" onClick={onRetry}>
				{t("entries.editor.retry")}
			</Button>
			{error === "errors.CHANGED_MEANWHILE" ? (
				<Button type="button" size="sm" variant="outline" onClick={() => window.location.reload()}>
					{t("entries.editor.reload")}
				</Button>
			) : null}
		</div>
	);
}

/** Publishing from an editor, as `useDraftPublish` gives it. */
export type DraftPublishing = {
	publish: () => Promise<void>;
	publishing: boolean;
	error: string | null;
	/** The list of problems, which gets focus when the Draft has some to fix first. */
	summary: RefObject<HTMLDivElement | null>;
};

/**
 * Publishing a Draft from its editor: what is still waiting to be saved is saved first, then
 * `publish` runs. A Draft refused for its problems (one of the `invalid` error codes) says so and
 * moves focus to the list of them.
 */
export function useDraftPublish(options: {
	flush: () => Promise<boolean>;
	publish: () => Promise<void>;
	invalid: readonly string[];
}): DraftPublishing {
	const t = useT();
	const summary = useRef<HTMLDivElement>(null);
	const afterRender = useAfterRender();
	const [publishing, setPublishing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const publish = async () => {
		setPublishing(true);
		setError(null);
		try {
			if (!(await options.flush())) {
				setError(t("entries.editor.saveFirst"));
				return;
			}
			await options.publish();
		} catch (failure) {
			if (options.invalid.includes(errorCode(failure) ?? "")) {
				setError(t("entries.editor.fixFirst"));
				afterRender(() => summary.current?.focus());
			} else {
				setError(t(errorMessage(failure)));
			}
		} finally {
			setPublishing(false);
		}
	};
	return { publish, publishing, error, summary };
}

/**
 * The Status card beside an editor: where the Draft stands, Save Draft, Publish (for those who may
 * publish), what publishing does, why it failed, and the Draft's problems. `children` adds what is
 * particular to the item, such as an Entry's address.
 */
export function DraftStatusCard(props: {
	status: "draft" | "published" | "changed";
	lastPublishedAt: Date | string | null;
	autosave: { status: AutosaveStatus; flush: () => Promise<boolean> };
	canPublish: boolean;
	publishDisabled?: boolean;
	publishing: DraftPublishing;
	publishHelp: MessageKey;
	problems: readonly Problem[];
	fields: readonly FieldDefinition[];
	idPrefix: string;
	headingId: string;
	children?: ReactNode;
}) {
	const t = useT();
	const { publishing } = props;
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t("entries.editor.statusHeading")}</h2>
				</CardTitle>
			</CardHeader>
			<CardContent className="grid gap-4">
				<div className="flex flex-wrap items-center justify-between gap-2 text-sm">
					<StatusBadge status={props.status} />
					{props.lastPublishedAt ? (
						<span className="text-muted-foreground">
							{t("entries.editor.liveSince", { date: formatUtc(props.lastPublishedAt) })}
						</span>
					) : null}
				</div>
				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						variant="outline"
						disabled={props.autosave.status === "saved"}
						onClick={() => void props.autosave.flush()}
					>
						{t("entries.editor.saveDraft")}
					</Button>
					{props.canPublish ? (
						<Button
							type="button"
							disabled={publishing.publishing || props.publishDisabled}
							onClick={publishing.publish}
						>
							<UploadIcon aria-hidden="true" />
							{t("entries.editor.publish")}
						</Button>
					) : null}
				</div>
				<p className="text-muted-foreground text-sm">
					{t(props.canPublish ? props.publishHelp : "entries.editor.authorHelp")}
				</p>
				{publishing.error ? (
					<p role="alert" className="text-destructive flex items-start gap-2 text-sm">
						<CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
						{publishing.error}
					</p>
				) : null}
				<div ref={publishing.summary} tabIndex={-1} className="outline-none">
					<ProblemSummary
						problems={props.problems}
						fields={props.fields}
						idPrefix={props.idPrefix}
						headingId={props.headingId}
					/>
				</div>
				{props.children}
			</CardContent>
		</Card>
	);
}
