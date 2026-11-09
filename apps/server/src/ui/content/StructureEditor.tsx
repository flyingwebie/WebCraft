import { useBlocker, useRouter } from "@tanstack/react-router";
import type { FieldInput } from "@webcraft/core";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { CircleAlertIcon, LockIcon } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { errorCode, errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { FieldBuilder, type FieldOwner } from "./FieldBuilder.tsx";
import type { SettingProblems } from "./FieldSettingsPanel.tsx";
import { draftsOf, type FieldDraft, findDraft, inputsOf, locateProblem, walk } from "./field-drafts.ts";
import type { FieldDefinition, Problem } from "./model.ts";
import { settingProblemText } from "./problems.ts";

/** A Post Type's own settings, as the screen edits them. */
type PostTypeSettings = { name: string; urlPattern: string };

/** What the screen saves: a Post Type (its name, URL pattern and Fields) or the Globals' Fields. */
export type StructureSubject =
	| {
			kind: "postType";
			id: string;
			key: string;
			name: string;
			urlPattern: string;
			builtIn: "page" | null;
			builtInFields: readonly string[];
			fields: readonly FieldDefinition[];
	  }
	| { kind: "globals"; fields: readonly FieldDefinition[] };

/** A problem the server answered, where it belongs: a Field's setting, or the Post Type's own. */
type Located = { uid: string | null; setting: string; message: string };

/**
 * The Post Types & Fields editor: a Post Type's name and URL pattern (or nothing more, for the
 * Globals) and its Fields in the Field builder. Changes stay on the screen until saved; saving sends
 * the whole list and applies at once (Structure has no Draft). Problems the server finds show at the
 * setting they are about, listed above the Fields too.
 */
export function StructureEditor({
	subject,
	siteId,
	defaultLanguage,
	postTypes,
	save,
}: {
	subject: StructureSubject;
	siteId: string;
	defaultLanguage: string;
	/** The Site's Post Types, which Relationships may point at. */
	postTypes: readonly { key: string; name: string }[];
	save(change: { settings: PostTypeSettings | null; fields: FieldInput[] }): Promise<readonly FieldDefinition[]>;
}) {
	const t = useT();
	const router = useRouter();
	const owner: FieldOwner = subject.kind === "globals" ? "globals" : subject.builtIn === "page" ? "page" : "postType";
	const initialSettings = subject.kind === "postType" ? { name: subject.name, urlPattern: subject.urlPattern } : null;
	const [settings, setSettings] = useState<PostTypeSettings | null>(initialSettings);
	const [drafts, setDrafts] = useState<FieldDraft[]>(() => draftsOf(subject.fields));
	const [baseline, setBaseline] = useState(() => JSON.stringify([initialSettings, inputsOf(drafts)]));
	const [selected, setSelected] = useState<string | null>(null);
	const [located, setLocated] = useState<Located[]>([]);
	const [failure, setFailure] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const summary = useRef<HTMLDivElement>(null);
	const dirty = JSON.stringify([settings, inputsOf(drafts)]) !== baseline;

	useBlocker({
		// Only leaving the page asks; moving within it (the skip link's #main) doesn't.
		shouldBlockFn: ({ current, next }) =>
			dirty && current.pathname !== next.pathname && !window.confirm(t("postTypes.leaveUnsaved")),
		enableBeforeUnload: () => dirty,
	});

	const problems = useMemo(() => {
		const byField = new Map<string, { setting: string; message: string }[]>();
		for (const problem of located) {
			if (problem.uid === null) continue;
			const list = byField.get(problem.uid) ?? [];
			list.push({ setting: problem.setting, message: problem.message });
			byField.set(problem.uid, list);
		}
		return byField as ReadonlyMap<string, SettingProblems>;
	}, [located]);
	const own = (setting: string) => located.filter((problem) => problem.uid === null && problem.setting === setting);

	const changeDrafts = (next: FieldDraft[]) => {
		setDrafts(next);
		// A Field's problems go once it changes; the next save checks again.
		const changed = new Set(
			walk(next)
				.filter(({ draft }) => findDraft(drafts, draft.uid)?.field !== draft.field)
				.map(({ draft }) => draft.uid),
		);
		if (changed.size > 0) setLocated((before) => before.filter((problem) => !problem.uid || !changed.has(problem.uid)));
	};

	const submit = async () => {
		setBusy(true);
		setFailure(null);
		const fields = inputsOf(drafts);
		try {
			const saved = await save({ settings, fields });
			const next = draftsOf(saved);
			const position = selected ? pathOf(drafts, selected) : null;
			setDrafts(next);
			setSelected(position ? (atPath(next, position)?.uid ?? null) : null);
			setLocated([]);
			setBaseline(JSON.stringify([settings, inputsOf(next)]));
			toast.success(t("postTypes.saved"));
			await router.invalidate();
		} catch (error) {
			const code = errorCode(error);
			const data = (error as { data?: { problems?: Problem[]; field?: string; path?: string } }).data;
			if ((code === "POST_TYPE_INVALID" || code === "GLOBALS_INVALID") && data?.problems) {
				setLocated(
					data.problems.map((problem) => ({
						...locateProblem(drafts, problem.at),
						message: settingProblemText(t, problem),
					})),
				);
				setFailure("postTypes.notSaved");
			} else if (code === "POST_TYPE_TAKEN") {
				setLocated([
					{
						uid: null,
						setting: data?.field === "key" ? "key" : "urlPattern",
						message: t(data?.field === "key" ? "errors.POST_TYPE_TAKEN_KEY" : "errors.POST_TYPE_TAKEN_URL_PATTERN"),
					},
				]);
				setFailure("postTypes.notSaved");
			} else if (code === "PATH_TAKEN") {
				setLocated([{ uid: null, setting: "urlPattern", message: t(errorMessage(error)) }]);
				setFailure("postTypes.notSaved");
			} else {
				setFailure(errorMessage(error));
			}
			requestAnimationFrame(() => summary.current?.focus());
		} finally {
			setBusy(false);
		}
	};

	const discard = () => {
		setSettings(initialSettings);
		setDrafts(draftsOf(subject.fields));
		setSelected(null);
		setLocated([]);
		setFailure(null);
	};

	const goTo = (problem: Located) => {
		if (problem.uid === null) {
			document.getElementById(`post-type-${problem.setting === "key" ? "key" : problem.setting}`)?.focus();
			return;
		}
		setSelected(problem.uid);
		requestAnimationFrame(() => {
			const option = /^options\[(\d+)\]\.(value|label)$/.exec(problem.setting);
			const id = option ? `setting-option-${option[1]}-${option[2]}` : `setting-${problem.setting.split(/[.[]/)[0]}`;
			(document.getElementById(id) ?? document.getElementById("field-settings-heading"))?.focus();
		});
	};

	const heading = subject.kind === "postType" ? subject.name : t("postTypes.globals.heading");

	return (
		<div className="grid min-w-0 content-start gap-8">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="grid gap-1">
					<div className="flex flex-wrap items-center gap-3">
						<h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
						<Badge variant="outline">{t("postTypes.staffOnly")}</Badge>
					</div>
					<p className="text-muted-foreground">
						{t(subject.kind === "postType" ? "postTypes.intro" : "postTypes.globals.intro")}
					</p>
				</div>
				<div className="flex items-center gap-3">
					<p role="status" className="text-muted-foreground text-sm">
						{dirty ? t("postTypes.unsaved") : ""}
					</p>
					<Button type="button" variant="outline" disabled={!dirty || busy} onClick={discard}>
						{t("postTypes.discard")}
					</Button>
					<Button type="button" disabled={!dirty || busy} onClick={submit}>
						{t("postTypes.save")}
					</Button>
				</div>
			</div>

			{failure ? (
				<div
					ref={summary}
					tabIndex={-1}
					role="alert"
					className="border-destructive/50 text-destructive grid gap-2 rounded-lg border p-4 text-sm outline-none"
				>
					<p className="flex items-center gap-2 font-medium">
						<CircleAlertIcon className="size-4" aria-hidden="true" />
						{t(failure)}
					</p>
					{located.length > 0 ? (
						<ul className="grid gap-1 ps-6">
							{located.map((problem) => (
								<li key={`${problem.uid}:${problem.setting}:${problem.message}`}>
									<button
										type="button"
										className="focus-visible:ring-ring/50 rounded-sm text-start underline underline-offset-4 outline-none focus-visible:ring-3"
										onClick={() => goTo(problem)}
									>
										{describe(t, drafts, problem)}
									</button>
								</li>
							))}
						</ul>
					) : null}
				</div>
			) : null}

			{subject.kind === "postType" && settings ? (
				<div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,12rem)]">
					<OwnSetting id="post-type-name" label={t("postTypes.name")} problems={own("name")}>
						{(described) => (
							<Input
								id="post-type-name"
								value={settings.name}
								maxLength={100}
								autoComplete="off"
								aria-describedby={described}
								aria-invalid={own("name").length > 0 ? true : undefined}
								onChange={(event) => setSettings({ ...settings, name: event.target.value })}
							/>
						)}
					</OwnSetting>
					<OwnSetting
						id="post-type-urlPattern"
						label={t("postTypes.urlPattern")}
						help={t(subject.builtIn === "page" ? "postTypes.urlPatternPagesHelp" : "postTypes.urlPatternHelp")}
						problems={own("urlPattern")}
					>
						{(described) => (
							<Input
								id="post-type-urlPattern"
								value={settings.urlPattern}
								readOnly={subject.builtIn === "page"}
								maxLength={500}
								autoComplete="off"
								spellCheck={false}
								className="font-mono"
								aria-describedby={described}
								aria-invalid={own("urlPattern").length > 0 ? true : undefined}
								onChange={(event) => setSettings({ ...settings, urlPattern: event.target.value })}
							/>
						)}
					</OwnSetting>
					<OwnSetting id="post-type-key" label={t("postTypes.key")} help={t("postTypes.keyHelp")} problems={own("key")}>
						{(described) => (
							<Input
								id="post-type-key"
								value={subject.key}
								readOnly
								className="font-mono"
								aria-describedby={described}
							/>
						)}
					</OwnSetting>
				</div>
			) : null}

			{subject.kind === "postType" ? (
				<div className="grid gap-2">
					<h2 className="text-muted-foreground flex items-center gap-2 text-sm font-medium">
						<LockIcon className="size-4" aria-hidden="true" />
						{t("postTypes.builtInFields")}
					</h2>
					<ul className="flex flex-wrap gap-2">
						{subject.builtInFields.map((name) => (
							<li key={name}>
								<Badge variant="secondary">{builtInName(t, name)}</Badge>
							</li>
						))}
					</ul>
				</div>
			) : null}

			{own("fields").length > 0 ? (
				<p className="text-destructive flex items-start gap-2 text-sm">
					<CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
					{own("fields")
						.map((problem) => problem.message)
						.join(" ")}
				</p>
			) : null}

			<FieldBuilder
				drafts={drafts}
				onChange={changeDrafts}
				selected={selected}
				onSelect={setSelected}
				problems={problems}
				owner={owner}
				postTypes={postTypes}
				siteId={siteId}
				defaultLanguage={defaultLanguage}
			/>
		</div>
	);
}

function builtInName(t: ReturnType<typeof useT>, name: string): string {
	switch (name) {
		case "title":
		case "slug":
		case "status":
		case "author":
		case "createdAt":
		case "updatedAt":
		case "publishedAt":
		case "lastPublishedAt":
		case "parent":
			return t(`content.builtIn.${name}`);
		default:
			return name;
	}
}

/** Where a problem is, in words: `Name`, or `Written by › key`. */
function describe(t: ReturnType<typeof useT>, drafts: readonly FieldDraft[], problem: Located): string {
	if (problem.uid === null) {
		const own: Record<string, MessageKey> = {
			name: "postTypes.name",
			urlPattern: "postTypes.urlPattern",
			key: "postTypes.key",
			fields: "postTypes.fields.heading",
		};
		const label = own[problem.setting];
		return `${label ? t(label) : problem.setting}: ${problem.message}`;
	}
	const draft = findDraft(drafts, problem.uid);
	const name = draft ? draft.field.label || draft.field.key : "";
	const option = /^options\[(\d+)\]/.exec(problem.setting);
	const setting = option
		? t("postTypes.settings.optionNumber", { number: Number(option[1]) + 1 })
		: SETTING_NAMES[problem.setting.split(/[.[]/)[0] ?? ""];
	const where = setting ? `${name} › ${typeof setting === "string" ? setting : t(setting)}` : name;
	return `${where}: ${problem.message}`;
}

/** The words for each setting a problem can be about. */
const SETTING_NAMES: Readonly<Record<string, MessageKey | undefined>> = {
	label: "postTypes.settings.label",
	key: "postTypes.settings.key",
	type: "postTypes.settings.type",
	help: "postTypes.settings.help",
	minLength: "postTypes.settings.minLength",
	maxLength: "postTypes.settings.maxLength",
	pattern: "postTypes.settings.pattern",
	min: "postTypes.settings.lowest",
	max: "postTypes.settings.highest",
	integer: "postTypes.settings.integer",
	mode: "postTypes.settings.mode",
	options: "postTypes.settings.options",
	multiple: "postTypes.settings.multiple",
	postTypes: "postTypes.settings.pointsAt",
	twoWay: "postTypes.settings.direction",
	default: "postTypes.settings.default",
	required: "postTypes.settings.required",
	translatable: "postTypes.settings.translatable",
	fields: "postTypes.fields.heading",
};

/** Where a draft is: its index in each list from the top. */
function pathOf(drafts: readonly FieldDraft[], uid: string): number[] | null {
	for (const [index, draft] of drafts.entries()) {
		if (draft.uid === uid) return [index];
		const inner = pathOf(draft.children, uid);
		if (inner) return [index, ...inner];
	}
	return null;
}

function atPath(drafts: readonly FieldDraft[], path: readonly number[]): FieldDraft | undefined {
	let list = drafts;
	let found: FieldDraft | undefined;
	for (const index of path) {
		found = list[index];
		if (!found) return undefined;
		list = found.children;
	}
	return found;
}

/** One of the Post Type's own settings: its label, control, help and problems. */
function OwnSetting({
	id,
	label,
	help,
	problems,
	children,
}: {
	id: string;
	label: string;
	help?: string;
	problems: readonly Located[];
	children(describedBy: string | undefined): ReactNode;
}) {
	const described =
		[help ? `${id}-help` : null, problems.length > 0 ? `${id}-problems` : null].filter(Boolean).join(" ") || undefined;
	return (
		<div className="grid content-start gap-1.5">
			<Label htmlFor={id}>{label}</Label>
			{children(described)}
			{help ? (
				<p id={`${id}-help`} className="text-muted-foreground text-sm">
					{help}
				</p>
			) : null}
			{problems.length > 0 ? (
				<ul id={`${id}-problems`} className="text-destructive grid gap-1 text-sm">
					{problems.map((problem) => (
						<li key={problem.message} className="flex items-start gap-1.5">
							<CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
							<span>{problem.message}</span>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
