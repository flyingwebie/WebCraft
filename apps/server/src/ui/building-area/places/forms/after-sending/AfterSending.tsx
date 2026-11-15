import { useEffect, useId, useState } from "react";

import { withText } from "../../../../forms/model.ts";
import { fill, type ShellConfig, type Words } from "../../../api.ts";
import { managementApi } from "../../../management.ts";
import { Sheet } from "../build-tab/Sheet.tsx";
import type { FormEditor } from "../editor.ts";
import { AdminLink, Card, INPUT_LOOK, LanguageTabs, Problem, Switch, WELL_LOOK } from "../parts.tsx";

/** Seconds the time trap asks for when it is switched on (the server's own default). */
const TIME_TRAP_SECONDS = 3;

const RTL = new Set(["ar", "fa", "he", "ur", "yi", "ps", "sd", "ug", "dv", "ku"]);

type PageChoice = { id: string; title: string; path: string | null };

/**
 * The After sending tab (BA-27; SPEC 15.2, `forms-builder/04`): what people see once the Form is sent
 * (a message here, in each of the Site's languages, or a Page they go on to), its spam checks (the
 * hidden trap field, always on; the time trap; how often one address may send it in an hour), and
 * where how long Submissions are kept is set. Each change is a step of the Form's Draft, saved after
 * the pause and published with its fields. On the right, the message as visitors will see it, on a
 * page sheet with the Site's own styles.
 */
export function AfterSending({
	config,
	words,
	editor,
	formId,
}: {
	config: ShellConfig;
	words: Words;
	editor: FormEditor;
	formId: string;
}) {
	const shown = words.forms.afterSending;
	const ids = useId();
	const version = editor.version;
	const success = version.success;
	const spam = version.spam;
	const languages = config.languages.all;
	const defaultLanguage = config.languages.default;
	const [language, setLanguage] = useState(defaultLanguage);
	const [pages, setPages] = useState<readonly PageChoice[] | null>(null);
	const [stylesheet, setStylesheet] = useState<string | null>(null);
	const problemAt = (at: string) =>
		editor.problems.find((problem) => problem.at === at || problem.at.startsWith(`${at}.`))?.message;

	// The Pages a Form may send people on to, and the Site's stylesheet for the preview.
	useEffect(() => {
		let current = true;
		const api = managementApi(config.token);
		const siteId = config.site.id;
		void (async () => {
			try {
				const { postTypes } = await api.postTypes.list({ siteId });
				const pagesType = postTypes.find((postType) => postType.builtIn === "page");
				const listed = pagesType ? (await api.entries.list({ siteId, postTypeId: pagesType.id })).entries : [];
				if (current)
					setPages(
						listed.map((entry) => ({ id: entry.id, title: (entry.published ?? entry.draft).title, path: entry.path })),
					);
			} catch {
				if (current) setPages([]);
			}
		})();
		api.designSystem
			.preview({ siteId })
			.then(({ preview }) => {
				if (current) setStylesheet(preview.stylesheet);
			})
			.catch(() => {
				if (current) setStylesheet("");
			});
		return () => {
			current = false;
		};
	}, [config.token, config.site.id]);

	const message = success.kind === "message" ? success.message : null;
	const shownLanguage = languages.some((each) => each.code === language) ? language : defaultLanguage;
	const messageIn = (code: string) =>
		message ? (code === defaultLanguage ? message.text : (message.translations?.[code] ?? "")) : "";
	const languageName = languages.find((each) => each.code === shownLanguage)?.name ?? shownLanguage;
	const page = success.kind === "redirect" ? pages?.find((each) => each.id === success.pageId) : null;
	const direction = RTL.has(shownLanguage.split("-")[0] ?? "") ? "rtl" : "ltr";

	return (
		<div className="flex min-h-0 grow gap-4 overflow-hidden" data-wc-after-sending="">
			<div className="flex w-[420px] shrink-0 flex-col gap-3 overflow-y-auto pb-2">
				<Card title={shown.whatTitle} id={`${ids}-what`}>
					<fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
						<legend className="sr-only">{shown.whatTitle}</legend>
						{(["message", "redirect"] as const).map((kind) => (
							<label key={kind} className="flex items-center gap-2.5 text-[12px] font-medium">
								<input
									type="radio"
									name={`${ids}-kind`}
									value={kind}
									checked={success.kind === kind}
									disabled={kind === "redirect" && pages !== null && pages.length === 0}
									onChange={() =>
										editor.changeVersion(
											{
												...version,
												success:
													kind === "redirect"
														? { kind: "redirect", pageId: pages?.[0]?.id ?? "" }
														: { kind: "message", message: { text: shown.defaultMessage } },
											},
											shown.history.what,
										)
									}
									className={`accent-selection size-4 ${FOCUS}`}
									data-wc-success-kind={kind}
								/>
								<span className={success.kind === kind ? "text-chrome-strong" : "text-chrome-muted"}>
									{kind === "message" ? shown.message : shown.page}
								</span>
							</label>
						))}
					</fieldset>
					{message ? (
						<>
							{languages.length > 1 ? (
								<LanguageTabs
									label={shown.languages}
									languages={languages}
									current={shownLanguage}
									panel={`${ids}-message`}
									onChoose={setLanguage}
								/>
							) : null}
							<div id={`${ids}-message`} role={languages.length > 1 ? "tabpanel" : undefined}>
								<textarea
									aria-label={fill(shown.messageIn, { language: languageName })}
									aria-describedby={problemAt("success") ? `${ids}-success-problem` : undefined}
									lang={shownLanguage}
									value={messageIn(shownLanguage)}
									placeholder={shownLanguage === defaultLanguage ? "" : message.text}
									onChange={(event) =>
										editor.changeVersion(
											{
												...version,
												success: {
													kind: "message",
													message: withText(
														message,
														shownLanguage === defaultLanguage ? null : shownLanguage,
														event.target.value,
													),
												},
											},
											shown.history.message,
											`after-sending:message:${shownLanguage}`,
										)
									}
									className={WELL_LOOK}
									data-wc-success-message={shownLanguage}
								/>
							</div>
						</>
					) : (
						<label className="flex flex-col gap-1.5">
							<span className="text-chrome-muted text-[11px]">{shown.pageLabel}</span>
							<select
								value={success.kind === "redirect" ? success.pageId : ""}
								onChange={(event) =>
									editor.changeVersion(
										{ ...version, success: { kind: "redirect", pageId: event.target.value } },
										shown.history.page,
									)
								}
								aria-describedby={problemAt("success") ? `${ids}-success-problem` : `${ids}-page-help`}
								className={`${INPUT_LOOK} [color-scheme:dark]`}
								data-wc-success-page=""
							>
								{(pages ?? []).map((each) => (
									<option key={each.id} value={each.id}>
										{each.path ? `${each.title} (${each.path})` : each.title}
									</option>
								))}
							</select>
							<span id={`${ids}-page-help`} className="text-chrome-muted text-[11px]">
								{shown.pageHelp}
							</span>
						</label>
					)}
					<Problem id={`${ids}-success-problem`}>{problemAt("success")}</Problem>
				</Card>

				<Card title={shown.spamTitle} id={`${ids}-spam`}>
					<div className="flex items-center justify-between gap-2">
						<span className="text-[12px]">{shown.trapField}</span>
						<span className="bg-chrome-hover text-chrome-strong rounded-[5px] px-1.5 py-0.5 text-[11px] font-medium">
							{shown.alwaysOn}
						</span>
					</div>
					<div className="flex items-center justify-between gap-2">
						<span id={`${ids}-time`} className="text-[12px]">
							{shown.timeTrap}
						</span>
						<Switch
							on={spam.minFillSeconds > 0}
							labelledBy={`${ids}-time`}
							onChange={(on) =>
								editor.changeVersion(
									{ ...version, spam: { ...spam, minFillSeconds: on ? TIME_TRAP_SECONDS : 0 } },
									shown.history.timeTrap,
								)
							}
							data-wc-time-trap=""
						/>
					</div>
					<div className="flex items-center gap-2">
						<label htmlFor={`${ids}-per-hour`} className="grow text-[12px]">
							{shown.atMost}
						</label>
						<input
							id={`${ids}-per-hour`}
							type="number"
							inputMode="numeric"
							min={0}
							value={spam.perHour}
							onChange={(event) => {
								const value = Number(event.target.value);
								if (event.target.value.trim() === "" || !Number.isFinite(value)) return;
								editor.changeVersion(
									{ ...version, spam: { ...spam, perHour: Math.max(0, Math.round(value)) } },
									shown.history.perHour,
									"after-sending:per-hour",
								);
							}}
							aria-describedby={`${ids}-per-hour-unit`}
							className={`${INPUT_LOOK} w-14 text-center font-mono`}
							data-wc-per-hour=""
						/>
						<span id={`${ids}-per-hour-unit`} className="text-[12px]">
							{shown.perHour}
						</span>
					</div>
					<Problem id={`${ids}-spam-problem`}>{problemAt("spam")}</Problem>
					<p className="text-chrome-muted m-0 text-[11px]">{shown.captcha}</p>
				</Card>

				<Card title={shown.keepTitle} id={`${ids}-keep`}>
					<p className="text-chrome-muted m-0 text-[12px]">{shown.keepText}</p>
					<AdminLink href={`${config.admin}/forms/${formId}?tab=submissions`} data-wc-keep-link="">
						{shown.keepLink}
					</AdminLink>
				</Card>
			</div>

			<div className="flex min-w-0 grow flex-col overflow-hidden p-3" data-wc-after-sending-preview="">
				<div className="grid h-full place-items-center overflow-auto rounded-[10px] bg-[#f8f6f2] p-6">
					{message ? (
						<Sheet
							stylesheet={stylesheet}
							language={shownLanguage}
							direction={direction}
							label={fill(shown.previewLabel, { language: languageName })}
						>
							<div className="wc-form-sent" role="status">
								<p>{messageIn(shownLanguage) || message.text}</p>
							</div>
						</Sheet>
					) : (
						<p className="m-0 max-w-sm text-center text-[13px] text-[#3f3f46]">
							{page ? fill(shown.goesTo, { page: page.title }) : shown.choosePage}
						</p>
					)}
				</div>
			</div>
		</div>
	);
}

/** The focus ring on a native radio, which draws its own box. */
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#fb923c]";
