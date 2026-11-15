import { CircleAlertIcon, LanguagesIcon, SparklesIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { type TranslatableText, translatableTexts, withText } from "../../../../forms/model.ts";
import { fill, type ShellConfig, type Words } from "../../../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../../../controls.tsx";
import { buttonLook } from "../../content/ui.tsx";
import { codeOf, type FormsApi, type OpenedForm } from "../data.ts";
import type { FormEditor } from "../editor.ts";

/** A row of the grid: what the text is, and the text with its setter. */
type Row = { what: string; text: TranslatableText };

/** What each text is, for the grid's first column ("Cake › Option 2", "Button › Words"). */
function rowsOf(words: Words, texts: readonly TranslatableText[]): Row[] {
	const shown = words.forms.translations.parts;
	const options = new Map<string | null, number>();
	return texts.map((text) => {
		if (text.part === "submitLabel") return { what: shown.submitLabel, text };
		if (text.part === "successMessage") return { what: shown.successMessage, text };
		const field = text.field ?? "";
		let part: string;
		if (text.part === "option") {
			const number = (options.get(field) ?? 0) + 1;
			options.set(field, number);
			part = fill(shown.option, { number: String(number) });
		} else part = shown[text.part];
		return { what: `${field} › ${part}`, text };
	});
}

/** Whether a text has words as written and none in `language` (what AI fills). */
function missing(text: TranslatableText, language: string): boolean {
	return text.text.text.trim() !== "" && !text.text.translations?.[language]?.trim();
}

/**
 * The Translations tab (BA-27; SPEC 15.2, `forms-builder/05`): every text of the Form beside its
 * translation, in one of the Site's other languages, with how many are missing in each; a missing one
 * is marked, and "Translate the missing ones with AI" fills them in the Draft (`forms.translateMissing`,
 * through the Workspace's AI key), one Undo step. A translation typed here is a step of the Draft too;
 * left empty, pages in that language show the text as written.
 */
export function Translations({
	config,
	words,
	editor,
	api,
	announce,
	onTaken,
}: {
	config: ShellConfig;
	words: Words;
	editor: FormEditor;
	api: FormsApi;
	announce(text: string, urgent?: boolean): void;
	onTaken(form: OpenedForm["form"]): void;
}) {
	const shown = words.forms.translations;
	const ids = useId();
	const defaultLanguage = config.languages.all.find((each) => each.code === config.languages.default);
	const others = config.languages.all.filter((each) => each.code !== config.languages.default);
	const [chosen, setChosen] = useState(others[0]?.code ?? "");
	const [busy, setBusy] = useState(false);
	const version = editor.version;
	const texts = useMemo(() => translatableTexts(version), [version]);
	const rows = useMemo(() => rowsOf(words, texts), [words, texts]);

	if (others.length === 0) {
		return (
			<p className="text-chrome-muted m-0 px-1 py-2 text-[12px]" data-wc-translations-none="">
				{shown.none}
			</p>
		);
	}
	const language = others.find((each) => each.code === chosen) ?? others[0];
	if (!language) return null;
	const missingIn = (code: string) => texts.filter((text) => missing(text, code)).length;
	const count = missingIn(language.code);

	const fillMissing = async () => {
		setBusy(true);
		announce(fill(shown.filling, { language: language.name }));
		try {
			// What waits is saved first, so AI reads the Draft as it is here.
			if (!(await editor.flush())) return;
			const answer = await api.translateMissing({
				siteId: config.site.id,
				formId: editor.formId,
				language: language.code,
			});
			if (answer.filled > 0) {
				editor.adopt(answer.form.draft, fill(shown.history.filled, { language: language.name }));
				onTaken(answer.form);
			}
			announce(fill(shown.filled, { count: String(answer.filled), language: language.name }));
		} catch (error) {
			const code = codeOf(error);
			const reason =
				code === "AI_KEY_MISSING"
					? shown.reasons.noKey
					: code === "AI_CAP_REACHED"
						? shown.reasons.cap
						: code === "AI_PROVIDER_FAILED"
							? shown.reasons.provider
							: fill(words.forms.reasons.generic, { code });
			announce(fill(shown.fillFailed, { reason }), true);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex min-h-0 grow flex-col gap-2.5" data-wc-translations="">
			<div className="flex flex-wrap items-center gap-3">
				<label className="relative flex items-center">
					<span className="sr-only">{shown.language}</span>
					<LanguagesIcon
						aria-hidden="true"
						className="text-chrome-muted pointer-events-none absolute start-2.5 size-3.5"
					/>
					<select
						value={language.code}
						onChange={(event) => setChosen(event.target.value)}
						className={`border-chrome-hover bg-chrome-raised text-chrome-strong h-8 appearance-none rounded-[7px] border ps-8 pe-3 text-[12px] font-medium [color-scheme:dark] ${CHROME_EASE} ${FOCUS_RING}`}
						data-wc-translation-language=""
					>
						{others.map((each) => (
							<option key={each.code} value={each.code}>
								{fill(shown.languageMissing, { language: each.name, count: String(missingIn(each.code)) })}
							</option>
						))}
					</select>
				</label>
				<button
					type="button"
					className={buttonLook("primary")}
					aria-disabled={busy || count === 0 || undefined}
					onClick={() => {
						if (!busy && count > 0) void fillMissing();
					}}
					data-wc-translate-missing=""
				>
					<SparklesIcon aria-hidden="true" className="size-3.5" />
					{busy ? shown.translating : shown.translateMissing}
				</button>
			</div>
			<div className="min-h-0 grow overflow-auto">
				<table className="w-full table-fixed border-collapse text-start text-[12px]" aria-describedby={`${ids}-intro`}>
					<caption id={`${ids}-intro`} className="sr-only">
						{fill(shown.intro, { language: language.name })}
					</caption>
					<thead>
						<tr className="bg-chrome-raised text-chrome-muted h-[34px] text-[11px] font-semibold tracking-wide uppercase">
							<th scope="col" className="w-[28%] px-2.5 text-start font-semibold">
								{shown.what}
							</th>
							<th scope="col" className="w-[40%] px-2.5 text-start font-semibold">
								{fill(shown.asWritten, { language: defaultLanguage?.name ?? config.languages.default })}
							</th>
							<th scope="col" className="px-2.5 text-start font-semibold">
								{language.name}
							</th>
						</tr>
					</thead>
					<tbody>
						{rows.map(({ what, text }) => {
							const value = text.text.translations?.[language.code] ?? "";
							const isMissing = missing(text, language.code);
							return (
								<tr key={text.id} className="border-chrome-hover h-11 border-b" data-wc-translation-row={text.id}>
									<th scope="row" className="text-chrome-strong truncate px-2.5 text-start font-medium">
										{what}
									</th>
									<td className="text-chrome-text truncate px-2.5" title={text.text.text}>
										{text.text.text}
									</td>
									<td className="px-1.5">
										<span className="relative flex items-center">
											<input
												aria-label={fill(shown.cell, { what, language: language.name })}
												lang={language.code}
												value={value}
												placeholder={isMissing ? shown.missing : ""}
												onChange={(event) =>
													editor.changeVersion(
														text.set(version, withText(text.text, language.code, event.target.value)),
														fill(shown.history.typed, { what }),
														`translation:${text.id}:${language.code}`,
													)
												}
												className={`h-[30px] w-full min-w-0 rounded-md border bg-transparent px-2 text-[12px] ${
													isMissing
														? "border-chrome-danger placeholder:text-chrome-danger border-dashed ps-7"
														: "text-chrome-text hover:border-chrome-hover focus:border-chrome-hover border-transparent"
												} ${CHROME_EASE} ${FOCUS_RING}`}
												data-wc-translation-cell={isMissing ? "missing" : "written"}
											/>
											{isMissing ? (
												<CircleAlertIcon
													aria-hidden="true"
													className="text-chrome-danger pointer-events-none absolute start-2 size-3"
												/>
											) : null}
										</span>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</div>
	);
}
