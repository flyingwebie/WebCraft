import type { AdminLanguageCode } from "@webcraft/core/admin-languages";
import {
	FileTextIcon,
	HammerIcon,
	LanguagesIcon,
	MailIcon,
	PlusIcon,
	SendIcon,
	SlidersHorizontalIcon,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { IntlProvider } from "use-intl";

import type en from "../../../../messages/en.json";
import { fill, type Words } from "../../api.ts";
import { DraftStateCell, draftStateOf } from "../../bottom-bar/DraftState.tsx";
import { CHROME_EASE, FOCUS_RING, type Icon } from "../../controls.tsx";
import { buttonLook } from "../content/ui.tsx";
import { rememberPlace } from "../memory.ts";
import { Place } from "../Place.tsx";
import type { PlaceProps } from "../registry.ts";
import { AfterSending } from "./after-sending/AfterSending.tsx";
import { Build } from "./build-tab/Build.tsx";
import { type FormListing, useFormsList, useOpenedForm } from "./data.ts";
import { useFormEditor } from "./editor.ts";
import { Emails } from "./emails/Emails.tsx";
import { NewFormDialog } from "./NewFormDialog.tsx";
import { Settings } from "./settings/Settings.tsx";
import { Translations } from "./translations/Translations.tsx";
import { FORM_TABS, type FormTab, formsAt, formsPlace, printBuildView, readBuildView } from "./view.ts";

/** Each tab's icon (SPEC 8: tabs that are sections of a place carry an icon and a word). */
const TAB_ICONS: Record<FormTab, Icon> = {
	build: HammerIcon,
	"after-sending": SendIcon,
	emails: MailIcon,
	translations: LanguagesIcon,
	settings: SlidersHorizontalIcon,
};

/** "Placed in 2 places", in the person's language. */
function placedText(words: Words, count: number, language: string): string {
	const shown = words.forms.placed;
	if (count === 0) return shown.none;
	return fill(shown[new Intl.PluralRules(language).select(count) === "one" ? "one" : "other"], {
		count: String(count),
	});
}

/**
 * The Forms place (BA-26; SPEC 15.2, `forms-builder/01` to `03` and `06`), behind the rail's "more":
 * the Site's Forms in the inner sidebar (each Draft or Published, and where it is placed), New Form,
 * and the open Form's tabs with icons (Build · After sending · Emails · Translations · Settings; the
 * last four BA-27's). The header holds the Form's Draft state (and Try it on Build); Publish on the
 * bottom bar publishes its fields, and the Emails tab publishes its emails apart. Forms are
 * Structure: the place is Staff's.
 */
export function FormsPlace(props: PlaceProps) {
	const { config, words, place, view, documents, leave, announce, onSaving, onBar } = props;
	const shown = words.forms;
	const staff = config.permissions.includes("structure.edit");
	const { api, forms, failed, forbidden, reload } = useFormsList(config.token, config.site.id);
	const at = formsAt(place) ?? { formId: null, tab: "build" as FormTab };
	const formId = at.formId ?? forms?.[0]?.id ?? null;
	const listing = forms?.find((each) => each.id === formId) ?? null;
	const opened = useOpenedForm(api, config.site.id, staff && !forbidden ? formId : null);
	const [creating, setCreating] = useState(false);
	const [trying, setTrying] = useState(false);
	const newButton = useRef<HTMLButtonElement>(null);
	const tabsId = useId();

	useEffect(() => rememberPlace(place, view), [place, view]);

	const takeForm = opened.take;
	const editor = useFormEditor({
		api,
		siteId: config.site.id,
		opened: opened.form?.form ?? null,
		words,
		announce,
		onSaving,
		onTaken: takeForm,
	});

	// The Form's own Draft state and Publish, on the bottom bar while the place is open.
	const changes = editor?.changes ?? null;
	const publish = editor?.publish;
	useEffect(() => {
		if (!onBar) return;
		onBar(
			changes === null || !publish
				? null
				: {
						changes,
						publish: async () => {
							const published = await publish();
							if (published) void reload();
							return published;
						},
					},
		);
	}, [onBar, changes, publish, reload]);
	useEffect(() => () => onBar?.(null), [onBar]);

	const openForm = useCallback(
		(id: string, tab: FormTab = at.tab) => {
			void editor?.flush();
			setTrying(false);
			documents.openPlace(formsPlace(id, tab));
		},
		[documents, editor, at.tab],
	);

	const name = opened.form?.form.name ?? listing?.name ?? "";
	const status = (row: FormListing): "draft" | "published" | "changed" => {
		if (row.id !== editor?.formId) return row.status;
		if (!editor.published) return "draft";
		return editor.changes > 0 ? "changed" : "published";
	};

	const sidebar =
		staff && !forbidden ? (
			<div className="flex flex-col gap-0.5" data-wc-forms-list="">
				{(forms ?? []).map((row) => {
					const current = row.id === formId;
					return (
						<button
							key={row.id}
							type="button"
							aria-current={current ? "page" : undefined}
							onClick={() => openForm(row.id)}
							className={`flex w-full flex-col gap-px rounded-md px-2 py-[5px] text-start ${
								current ? "bg-chrome-raised" : "hover:bg-chrome-raised"
							} ${CHROME_EASE} ${FOCUS_RING}`}
							data-wc-form-row={row.id}
						>
							<span className="flex h-5 w-full items-center gap-2">
								<FileTextIcon
									aria-hidden="true"
									className={`size-3.5 shrink-0 ${current ? "text-chrome-strong" : "text-chrome-muted"}`}
								/>
								<span
									className={`min-w-0 grow truncate text-[12px] font-medium ${current ? "text-chrome-strong" : "text-chrome-muted"}`}
								>
									{row.name}
								</span>
							</span>
							<span className="text-chrome-muted truncate ps-[22px] text-[11px]">
								{`${shown.status[status(row)]} · ${placedText(words, row.usage.usedIn.length, config.language)}`}
							</span>
						</button>
					);
				})}
				<button
					ref={newButton}
					type="button"
					onClick={() => setCreating(true)}
					className={`text-chrome-muted hover:text-chrome-text hover:bg-chrome-raised flex h-[31px] w-full items-center gap-2 rounded-md px-2 text-start text-[12px] ${CHROME_EASE} ${FOCUS_RING}`}
					data-wc-new-form-open=""
				>
					<PlusIcon aria-hidden="true" className="size-3.5 shrink-0" />
					{shown.newForm.title}
				</button>
			</div>
		) : null;

	const header = editor ? (
		<div className="flex items-center gap-3">
			{at.tab === "build" && trying ? <span className="text-chrome-muted text-[12px]">{shown.tryIt.help}</span> : null}
			{at.tab === "build" ? (
				<span className="flex items-center gap-2">
					<span id={`${tabsId}-try`} className="text-chrome-strong text-[12px] font-medium">
						{shown.tryIt.label}
					</span>
					<button
						type="button"
						role="switch"
						aria-checked={trying}
						aria-labelledby={`${tabsId}-try`}
						onClick={() => {
							setTrying(!trying);
							announce(trying ? shown.tryIt.off : shown.tryIt.on);
						}}
						className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full ${
							trying ? "bg-chrome-ok" : "bg-chrome-hover"
						} ${CHROME_EASE} ${FOCUS_RING}`}
						data-wc-try-it=""
					>
						<span
							aria-hidden="true"
							className={`bg-chrome-strong absolute top-0.5 size-3 rounded-full ${trying ? "end-0.5" : "start-0.5"}`}
						/>
					</button>
				</span>
			) : null}
			<DraftStateCell
				state={draftStateOf(editor.saving, { changes: editor.changes, inReview: false })}
				words={words}
				language={config.language}
			/>
		</div>
	) : null;

	let body: ReactNode;
	if (!staff || forbidden) {
		body = <Notice>{shown.staffOnly}</Notice>;
	} else if (failed) {
		body = <Notice alert>{fill(shown.loadFailed, { reason: failed })}</Notice>;
	} else if (!forms) {
		body = <Notice busy>{shown.loading}</Notice>;
	} else if (forms.length === 0) {
		body = (
			<div className="grid grow place-items-center p-8" data-wc-forms-empty="">
				<div className="flex max-w-sm flex-col items-center gap-3 text-center">
					<h2 className="text-chrome-strong m-0 text-[14px] font-semibold">{shown.empty.title}</h2>
					<p className="text-chrome-muted m-0 text-[12px]">{shown.empty.text}</p>
					<button type="button" className={buttonLook("primary")} onClick={() => setCreating(true)}>
						<PlusIcon aria-hidden="true" className="size-3.5" />
						{shown.newForm.title}
					</button>
				</div>
			</div>
		);
	} else if (formId) {
		const tabPanel = `${tabsId}-panel`;
		let content: ReactNode;
		if (opened.failed) content = <Notice alert>{fill(shown.formFailed, { reason: opened.failed })}</Notice>;
		else if (!editor) content = <Notice busy>{shown.loading}</Notice>;
		else if (at.tab === "build")
			content = (
				<IntlProvider
					locale={config.language as AdminLanguageCode}
					// Only the parts the reused field settings read: what they don't is never asked for.
					messages={config.adminMessages as unknown as typeof en}
					timeZone="UTC"
				>
					<Build
						config={config}
						words={words}
						editor={editor}
						formName={name}
						view={readBuildView(view)}
						onView={(next) => documents.setView(printBuildView(next), "replace")}
						trying={trying}
						announce={announce}
					/>
				</IntlProvider>
			);
		else if (at.tab === "after-sending")
			content = <AfterSending config={config} words={words} editor={editor} formId={formId} />;
		else if (at.tab === "translations")
			content = (
				<Translations config={config} words={words} editor={editor} api={api} announce={announce} onTaken={takeForm} />
			);
		else if (at.tab === "emails" && opened.form)
			content = (
				<Emails
					key={formId}
					config={config}
					words={words}
					api={api}
					form={opened.form.form}
					fields={editor.version.fields}
					announce={announce}
					onTaken={takeForm}
				/>
			);
		else if (at.tab === "settings" && opened.form)
			content = (
				<Settings
					key={formId}
					config={config}
					words={words}
					editor={editor}
					api={api}
					form={opened.form.form}
					listing={listing}
					announce={announce}
					onRenamed={(form) => {
						takeForm(form);
						void reload();
					}}
				/>
			);
		body = (
			<div className="flex min-h-0 grow flex-col gap-2.5">
				<FormTabs
					words={words}
					name={name}
					current={at.tab}
					panel={tabPanel}
					onTab={(tab) => {
						setTrying(false);
						documents.openPlace(formsPlace(formId, tab));
					}}
				/>
				<div
					id={tabPanel}
					role="tabpanel"
					aria-label={shown.tabs[tabKey(at.tab)]}
					className="flex min-h-0 grow flex-col"
				>
					{content}
				</div>
			</div>
		);
	}

	return (
		<Place
			words={words}
			title={words.places.forms}
			backTo={null}
			onBack={leave}
			place={place}
			shape="header"
			actions={header}
			sidebar={sidebar}
			sidebarLabel={shown.sidebar}
		>
			{body}
			{creating ? (
				<NewFormDialog
					words={words}
					api={api}
					siteId={config.site.id}
					onClose={() => {
						setCreating(false);
						newButton.current?.focus();
					}}
					onMade={(id, made) => {
						setCreating(false);
						announce(fill(shown.newForm.made, { name: made }));
						void reload();
						openForm(id, "build");
					}}
				/>
			) : null}
		</Place>
	);
}

/** A tab's key among the words (`after-sending` is `afterSending`). */
function tabKey(tab: FormTab): keyof Words["forms"]["tabs"] {
	return tab === "after-sending" ? "afterSending" : tab;
}

/** A message in the place's pane: waiting, refused, or for Staff only. */
function Notice({ children, alert, busy }: { children: ReactNode; alert?: boolean; busy?: boolean }) {
	return (
		<p
			role={alert ? "alert" : undefined}
			aria-busy={busy || undefined}
			className={`m-0 px-4 py-2 text-[12px] ${alert ? "text-chrome-danger" : "text-chrome-muted"}`}
			data-wc-forms-notice=""
		>
			{children}
		</p>
	);
}

/** The Form's tabs with icons (`forms-builder/01`): each an address of the place (`forms/<id>/<tab>`). */
function FormTabs({
	words,
	name,
	current,
	panel,
	onTab,
}: {
	words: Words;
	name: string;
	current: FormTab;
	panel: string;
	onTab(tab: FormTab): void;
}) {
	const list = useRef<HTMLDivElement>(null);
	const onKey = (event: KeyboardEvent<HTMLButtonElement>, tab: FormTab) => {
		const at = FORM_TABS.indexOf(tab);
		const next =
			event.key === "ArrowRight"
				? FORM_TABS[(at + 1) % FORM_TABS.length]
				: event.key === "ArrowLeft"
					? FORM_TABS[(at + FORM_TABS.length - 1) % FORM_TABS.length]
					: event.key === "Home"
						? FORM_TABS[0]
						: event.key === "End"
							? FORM_TABS.at(-1)
							: undefined;
		if (!next) return;
		event.preventDefault();
		onTab(next);
		requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-wc-form-tab="${next}"]`)?.focus());
	};
	return (
		<div
			ref={list}
			role="tablist"
			aria-label={fill(words.forms.tabsLabel, { name })}
			className="flex shrink-0 items-center gap-1.5"
		>
			{FORM_TABS.map((tab) => {
				const Glyph = TAB_ICONS[tab];
				const selected = tab === current;
				return (
					<button
						key={tab}
						type="button"
						role="tab"
						aria-selected={selected}
						aria-controls={selected ? panel : undefined}
						tabIndex={selected ? 0 : -1}
						onClick={() => onTab(tab)}
						onKeyDown={(event) => onKey(event, tab)}
						className={`border-chrome-hover flex h-8 items-center gap-1.5 rounded-[7px] border px-3 text-[12px] font-medium ${
							selected ? "bg-chrome-raised text-chrome-strong" : "text-chrome-muted hover:text-chrome-text"
						} ${CHROME_EASE} ${FOCUS_RING}`}
						data-wc-form-tab={tab}
					>
						<Glyph aria-hidden="true" className="size-3.5" />
						{words.forms.tabs[tabKey(tab)]}
					</button>
				);
			})}
		</div>
	);
}
