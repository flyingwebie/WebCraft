import type { BuildingAreaApiClient } from "@webcraft/api";
import type { FormVersion } from "@webcraft/renderer/forms";
import { InboxIcon, SquarePenIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useState, useSyncExternalStore } from "react";

import { replaceAt } from "../../builder/tree.ts";
import { fill, type ShellConfig, type Words } from "../api.ts";
import { rememberFormNames } from "../canvas/placed-form.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";
import type { Structure } from "../editing/selection.ts";
import { managementApi } from "../management.ts";

type Listed = Awaited<ReturnType<BuildingAreaApiClient["forms"]["list"]>>["forms"][number];

/** "13 fields · 2 steps · Published", from the version visitors see (the Draft before the first publish). */
function summaryOf(words: Words, language: string, form: Listed): string {
	const shown = words.forms.onPage;
	const version: FormVersion = form.published ?? form.draft;
	const fields = version.fields.filter((field) => field.type !== "section" && field.type !== "step").length;
	const steps = version.fields.filter((field) => field.type === "step").length;
	const plural = (count: number) => (new Intl.PluralRules(language).select(count) === "one" ? "one" : "other");
	const status =
		form.status === "draft"
			? words.forms.status.draft
			: form.status === "published"
				? words.forms.status.published
				: words.forms.status.changed;
	return fill(shown.summary, {
		fields: fill(shown.fields[plural(fields)], { count: String(fields) }),
		steps: steps === 0 ? shown.steps.none : fill(shown.steps[plural(steps)], { count: String(steps) }),
		status,
	});
}

/**
 * A Form placed on a page, selected on the canvas or in Layers (BA-27; SPEC 15.3, `forms/04`): it is
 * one thing there, its fields never chosen one by one. The Inspector names it and offers another of
 * the Site's Forms in its place (a change to the Template or Component that places it, one Undo
 * step), says what it holds, opens it in the Forms place ("Edit this Form") and opens its Submissions
 * in the admin, with how many are new. Anything else selected shows `fallback`, the Inspector itself.
 */
export function FormPanel({
	config,
	words,
	structure,
	fallback,
	announce,
	onEdit,
}: {
	config: ShellConfig;
	words: Words;
	structure: Structure;
	fallback: ReactNode;
	announce(text: string, urgent?: boolean): void;
	/** Opens the Form in the Forms place, from the page it is on. */
	onEdit(formId: string): void;
}) {
	const shown = words.forms.onPage;
	const ids = useId();
	const snapshot = useSyncExternalStore(structure.subscribe, structure.snapshot);
	const [forms, setForms] = useState<readonly Listed[] | null>(null);
	const selection = snapshot.selection;
	const node = selection?.node;
	const placed = node?.type === "form" ? node : null;

	// The Site's Forms: their names (the chips' too), what each holds and how many Submissions are new.
	useEffect(() => {
		if (!placed) return;
		let current = true;
		managementApi(config.token)
			.forms.list({ siteId: config.site.id })
			.then(({ forms: listed }) => {
				if (!current) return;
				rememberFormNames(listed);
				setForms(listed);
			})
			.catch(() => {
				if (current) setForms([]);
			});
		return () => {
			current = false;
		};
	}, [placed, config.token, config.site.id]);

	if (!placed || !selection) return <>{fallback}</>;
	const source = snapshot.sources.get(selection.source);
	const editable = Boolean(source?.editable && selection.path);
	const form = forms?.find((each) => each.id === placed.form) ?? null;
	const name = form?.name ?? shown.unnamed;
	const fresh = form?.newSubmissions ?? 0;

	const swap = (formId: string) => {
		const other = forms?.find((each) => each.id === formId);
		if (!source || !selection.path || !other || formId === placed.form) return;
		const refused = structure.change(
			selection.source,
			replaceAt(source.tree, selection.path, { ...placed, form: formId }),
			fill(shown.history, { name: other.name }),
		);
		if (refused) announce(fill(shown.swapFailed, { name: other.name, reason: refused }), true);
		else announce(fill(shown.swapped, { name: other.name }));
	};

	return (
		<div className="flex flex-col gap-2.5 p-3 text-[12px]" data-wc-form-panel={placed.form}>
			<label className="bg-chrome-raised flex flex-col gap-0.5 rounded-lg px-2 py-1.5">
				<span className="text-chrome-muted text-[11px]">{shown.form}</span>
				<select
					value={placed.form}
					disabled={!editable || !forms}
					aria-describedby={editable ? `${ids}-summary` : `${ids}-summary ${ids}-locked`}
					onChange={(event) => swap(event.target.value)}
					className={`text-chrome-strong -mx-1 rounded-sm bg-transparent px-1 text-[12px] font-medium [color-scheme:dark] disabled:opacity-80 ${FOCUS_RING}`}
					data-wc-form-choice=""
				>
					{forms && !form ? <option value={placed.form}>{name}</option> : null}
					{(forms ?? []).map((each) => (
						<option key={each.id} value={each.id}>
							{each.name}
						</option>
					))}
				</select>
			</label>
			<p id={`${ids}-summary`} className="text-chrome-muted m-0 text-[11px]" data-wc-form-summary="">
				{form ? summaryOf(words, config.language, form) : ""}
			</p>
			{editable ? null : (
				<p id={`${ids}-locked`} className="text-chrome-muted m-0 text-[11px]">
					{shown.readOnly}
				</p>
			)}
			<button
				type="button"
				onClick={() => onEdit(placed.form)}
				className={`border-chrome-hover text-chrome-strong hover:bg-chrome-hover flex h-8 items-center justify-center gap-1.5 rounded-[7px] border text-[12px] font-semibold ${CHROME_EASE} ${FOCUS_RING}`}
				data-wc-edit-form=""
			>
				<SquarePenIcon aria-hidden="true" className="size-3.5" />
				{shown.edit}
			</button>
			<a
				href={`${config.admin}/forms/${placed.form}?tab=submissions`}
				target="_blank"
				rel="noopener noreferrer"
				className={`bg-chrome-raised text-chrome-strong hover:bg-chrome-hover flex h-8 items-center gap-1.5 rounded-[7px] px-2.5 text-[12px] font-semibold ${CHROME_EASE} ${FOCUS_RING}`}
				data-wc-see-submissions=""
			>
				<InboxIcon aria-hidden="true" className="size-3.5" />
				<span className="grow">{shown.submissions}</span>
				{fresh > 0 ? (
					<span className="rounded-[5px] bg-[#1e3a8a] px-1.5 py-0.5 text-[11px] font-semibold text-[#dbeafe]">
						{fill(shown.newCount, { count: String(fresh) })}
					</span>
				) : null}
			</a>
			<p className="text-chrome-muted m-0 text-[11px]">{shown.notChosen}</p>
		</div>
	);
}

/** The Inspector's heading while a placed Form is selected: "Form" (`forms/04`). */
export function FormPanelHeading({ words }: { words: Words }) {
	return <span className="text-chrome-strong shrink-0 text-[12px] font-semibold">{words.forms.onPage.panel}</span>;
}
