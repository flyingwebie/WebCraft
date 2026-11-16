import { type FormEvent, useId, useState } from "react";

import { type FormProblem, problemsOf, withText } from "../../../../forms/model.ts";
import { fill, type ShellConfig, type Words } from "../../../api.ts";
import { buttonLook } from "../../content/ui.tsx";
import { type FormListing, type FormsApi, type OpenedForm, reasonText } from "../data.ts";
import type { FormEditor } from "../editor.ts";
import { AdminLink, Card, INPUT_LOOK, Problem } from "../parts.tsx";

/**
 * The Settings tab (BA-27; SPEC 15.2): the Form's name and key, saved at once (`forms.rename`; not
 * part of the Draft, and every Template and Component placing it follows), its button's words (a step
 * of the Draft, published with its fields), where it is placed, and a link to what stays the admin's
 * (the Site's CAPTCHA, the Form's history, deleting it).
 */
export function Settings({
	config,
	words,
	editor,
	api,
	form,
	listing,
	announce,
	onRenamed,
}: {
	config: ShellConfig;
	words: Words;
	editor: FormEditor;
	api: FormsApi;
	form: OpenedForm["form"];
	listing: FormListing | null;
	announce(text: string, urgent?: boolean): void;
	onRenamed(form: OpenedForm["form"]): void;
}) {
	const shown = words.forms.settings;
	const ids = useId();
	const [name, setName] = useState(form.name);
	const [key, setKey] = useState(form.key);
	const [problems, setProblems] = useState<readonly FormProblem[]>([]);
	const [busy, setBusy] = useState(false);
	const version = editor.version;
	const problemAt = (at: string) => problems.find((problem) => problem.at === at)?.message;
	const buttonProblem = editor.problems.find((problem) => problem.at.startsWith("submitLabel"))?.message;
	const changed = name !== form.name || key !== form.key;
	const usedIn = listing?.usage.usedIn ?? [];

	const save = async (event: FormEvent) => {
		event.preventDefault();
		if (busy || !changed) return;
		setBusy(true);
		setProblems([]);
		try {
			const answer = await api.rename({ siteId: config.site.id, formId: form.id, name, key });
			onRenamed(answer.form);
			announce(fill(shown.renamed, { name: answer.form.name }));
		} catch (error) {
			const found = problemsOf(error);
			if (found.length > 0) setProblems(found);
			announce(fill(shown.renameFailed, { reason: reasonText(words, error) }), true);
		} finally {
			setBusy(false);
		}
	};

	const placedText = (placement: (typeof usedIn)[number]) =>
		placement.kind === "siteTemplate"
			? shown.placedOn.siteTemplate
			: placement.kind === "entryTemplate"
				? fill(shown.placedOn.entryTemplate, { name: placement.name ?? "" })
				: placement.kind === "archiveTemplate"
					? fill(shown.placedOn.archiveTemplate, { name: placement.name ?? "" })
					: fill(shown.placedOn.component, { name: placement.name ?? "" });

	return (
		<div className="flex min-h-0 grow flex-col overflow-y-auto pb-2" data-wc-form-settings="">
			<div className="flex w-full max-w-[520px] flex-col gap-3">
				<Card title={shown.nameTitle} id={`${ids}-name-title`}>
					<p className="text-chrome-muted m-0 text-[12px]">{shown.nameIntro}</p>
					<form className="flex flex-col gap-3" onSubmit={(event) => void save(event)} noValidate>
						<label className="flex flex-col gap-1.5">
							<span className="text-chrome-muted text-[11px]">{shown.name}</span>
							<input
								value={name}
								onChange={(event) => setName(event.target.value)}
								aria-invalid={problemAt("name") ? true : undefined}
								aria-describedby={problemAt("name") ? `${ids}-name-problem` : undefined}
								className={INPUT_LOOK}
								data-wc-form-name=""
							/>
							<Problem id={`${ids}-name-problem`}>{problemAt("name")}</Problem>
						</label>
						<label className="flex flex-col gap-1.5">
							<span className="text-chrome-muted text-[11px]">{shown.key}</span>
							<input
								value={key}
								onChange={(event) => setKey(event.target.value)}
								spellCheck={false}
								aria-invalid={problemAt("key") ? true : undefined}
								aria-describedby={`${ids}-key-help${problemAt("key") ? ` ${ids}-key-problem` : ""}`}
								className={`${INPUT_LOOK} font-mono`}
								data-wc-form-key=""
							/>
							<span id={`${ids}-key-help`} className="text-chrome-muted text-[11px]">
								{fill(shown.keyHelp, { placed: `{{@form ${key || form.key}}}` })}
							</span>
							<Problem id={`${ids}-key-problem`}>{problemAt("key")}</Problem>
						</label>
						<button
							type="submit"
							className={`${buttonLook("outline")} self-start`}
							aria-disabled={busy || !changed || undefined}
							data-wc-rename=""
						>
							{busy ? shown.renaming : shown.rename}
						</button>
					</form>
				</Card>

				<Card title={shown.buttonTitle} id={`${ids}-button-title`}>
					<label className="flex flex-col gap-1.5">
						<span className="text-chrome-muted text-[11px]">{shown.buttonText}</span>
						<input
							value={version.submitLabel.text}
							onChange={(event) =>
								editor.changeVersion(
									{ ...version, submitLabel: withText(version.submitLabel, null, event.target.value) },
									shown.history.button,
									"settings:button",
								)
							}
							aria-describedby={buttonProblem ? `${ids}-button-problem` : `${ids}-button-help`}
							className={INPUT_LOOK}
							data-wc-submit-label=""
						/>
						<span id={`${ids}-button-help`} className="text-chrome-muted text-[11px]">
							{shown.buttonHelp}
						</span>
						<Problem id={`${ids}-button-problem`}>{buttonProblem}</Problem>
					</label>
				</Card>

				<Card title={shown.placedTitle} id={`${ids}-placed-title`}>
					{usedIn.length === 0 ? (
						<p className="text-chrome-muted m-0 text-[12px]">{shown.notPlaced}</p>
					) : (
						<ul className="m-0 flex list-disc flex-col gap-1 ps-4 text-[12px]" data-wc-form-placed="">
							{usedIn.map((placement, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: what places it, in its order.
								<li key={index}>{placedText(placement)}</li>
							))}
						</ul>
					)}
				</Card>

				<Card title={shown.adminTitle} id={`${ids}-admin-title`}>
					<p className="text-chrome-muted m-0 text-[12px]">{shown.adminText}</p>
					<AdminLink href={`${config.admin}/forms/${form.id}?tab=settings`} data-wc-settings-admin="">
						{shown.adminLink}
					</AdminLink>
				</Card>
			</div>
		</div>
	);
}
