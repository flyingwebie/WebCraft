import { Link, useRouter } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { Button, buttonVariants } from "@webcraft/ui/components/button.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { cn } from "@webcraft/ui/lib/utils.ts";
import { PlusIcon, TrashIcon, WrenchIcon } from "lucide-react";
import { type ReactNode, type RefObject, useId, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { Checks } from "../Checks.tsx";
import { useCoEditedValues } from "../co-editing/co-edited.ts";
import {
	PresenceList,
	PresenceOutline,
	SharedDraftBanner,
	SharedDraftStatus,
	usePlaceTracking,
} from "../co-editing/Presence.tsx";
import { documentValues, readFieldValues, withFieldValues } from "../co-editing/values.ts";
import { FieldValueList } from "../content/FieldValues.tsx";
import type { FieldDefinition, FieldValues } from "../content/model.ts";
import { errorMessage } from "../errors.ts";
import { HistoryLink } from "../history/HistoryLink.tsx";
import { useT } from "../i18n.tsx";
import type { MediaItem } from "../media/preview.ts";
import { ReviewStatus, SubmitForReview } from "../review/Review.tsx";
import { ConfirmDialog } from "../settings/confirm.tsx";
import { SettingsRow, SettingsRows, StateBadge, Switch } from "../settings/layout.tsx";
import { PageSheet } from "../shell/page.tsx";

/** A row of the sheet: its label left and its control right where the sheet is wide enough. */
const ROW = "@lg/sheet:flex-row @lg/sheet:items-center @lg/sheet:justify-between @lg/sheet:gap-6";

export type PopupView = Awaited<ReturnType<ApiClient["popups"]["get"]>>;
type Settings = PopupView["popup"]["draft"];
type Trigger = Settings["trigger"];

/** A Popup's state, as a badge: published, published with changes waiting, or never published. */
export function PopupStatus({ status }: { status: "draft" | "published" | "changed" }) {
	const t = useT();
	return (
		<StateBadge tone={status === "published" ? "success" : status === "changed" ? "warning" : "neutral"}>
			{t(`popups.status.${status}`)}
		</StateBadge>
	);
}

/**
 * One Popup in a sheet over the Popups list: its Content (each language's title, text and image, on
 * or off and its dates; co-edited, saved as it is typed, with Review and History), then for Staff its
 * Structure as rows: the layout, the Triggers and the Display rules, its Checks, and in the sheet's
 * foot Save Draft and Publish (the Structure publish takes its Component along). Closing the sheet
 * goes back to the list.
 */
export function PopupSheet({
	view,
	knownMedia,
	siteId,
	structure,
	permissions,
	languages,
	postTypes,
	entries,
	onClose,
	onLanguage,
	finalFocus,
}: {
	view: PopupView;
	knownMedia: Readonly<Record<string, MediaItem>>;
	siteId: string;
	structure: boolean;
	permissions: readonly string[];
	languages: { default: string; all: readonly string[] };
	postTypes: { id: string; name: string }[];
	entries: { id: string; title: string }[];
	onClose: () => void;
	/** Opens the Popup's Content in another language. */
	onLanguage: (language: string) => Promise<void>;
	finalFocus?: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const router = useRouter();
	const uid = useId();
	const [settings, setSettings] = useState(view.popup.draft);
	const [triggerKeys, setTriggerKeys] = useState(() =>
		view.popup.draft.additionalTriggers.map(() => crypto.randomUUID()),
	);
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [media, setMedia] = useState(knownMedia);
	const popupId = view.popup.id;
	const valueLanguages = { language: view.content.language, defaultLanguage: languages.default };
	const coEdited = useCoEditedValues<FieldValues, FieldValues>({
		path: `/api/drafts/${siteId}/popupContent/${popupId}`,
		initial: view.content.draft.values as FieldValues,
		read: (draft) => readFieldValues(documentValues(draft), view.content.fields, valueLanguages),
		write: (draft, change) => withFieldValues(draft, change, view.content.fields, valueLanguages),
		merge: (before, change) => ({ ...before, ...change }),
		onRefused: (error) => setMessage(t(errorMessage(error))),
		onSettled: () => {},
	});
	const { values, shared } = coEdited;
	const tracking = usePlaceTracking(shared.place);

	const run = async (work: (api: ApiClient) => Promise<unknown>, published = false) => {
		setBusy(true);
		setMessage("");
		try {
			if (!(await coEdited.autosave.flush())) return;
			await work(await getApi());
			setMessage(t(published ? "popups.published" : "popups.saved"));
			await router.invalidate();
		} catch (error) {
			setMessage(t(errorMessage(error)));
		} finally {
			setBusy(false);
		}
	};
	const option = (value: string) => t(`popups.options.${value as "modal"}`);
	const select = (
		label: "layout" | "visitors" | "frequency" | "animation" | "barPosition" | "barBehavior",
		value: string,
		choices: string[],
		change: (value: string) => void,
	) => (
		<SettingsRow className={ROW} label={t(`popups.${label}`)} htmlFor={`${uid}-${label}`}>
			<NativeSelect
				className="w-full min-w-0 @lg/sheet:w-64"
				id={`${uid}-${label}`}
				value={value}
				onChange={(e) => change(e.target.value)}
			>
				{choices.map((v) => (
					<NativeSelectOption key={v} value={v}>
						{option(v)}
					</NativeSelectOption>
				))}
			</NativeSelect>
		</SettingsRow>
	);
	const many = (
		label: "postTypes" | "entries" | "languages" | "devices" | "excludePostTypes" | "excludeEntries",
		choices: { id: string; name: string }[],
		selected: string[],
		change: (ids: string[]) => void,
	) => (
		<ChoiceRow label={t(`popups.${label}`)} help={t(`popups.ruleHelp.${label}`)}>
			{choices.length === 0 ? (
				<p className="text-muted-foreground text-sm">{t("popups.noChoices")}</p>
			) : (
				choices.map((v) => (
					<label key={v.id} className="flex min-h-8 items-center gap-2 text-sm">
						<input
							className="accent-primary size-4"
							type="checkbox"
							checked={selected.includes(v.id)}
							onChange={(e) => change(e.target.checked ? [...selected, v.id] : selected.filter((id) => id !== v.id))}
						/>
						{v.name}
					</label>
				))
			)}
		</ChoiceRow>
	);
	const rules = (patch: Partial<typeof settings.rules>) =>
		setSettings((s) => ({ ...s, rules: { ...s.rules, ...patch } }));
	const entryChoices = entries.map((e) => ({ id: e.id, name: e.title }));
	return (
		<PageSheet
			open
			onOpenChange={(open) => !open && onClose()}
			title={view.popup.name}
			description={
				<span className="flex flex-wrap items-center gap-2">
					<PopupStatus status={view.popup.status} />
					<span className="font-mono text-xs">{view.popup.key}</span>
				</span>
			}
			finalFocus={finalFocus}
			className="data-[side=right]:sm:max-w-2xl"
			footer={
				structure ? (
					<>
						<div className="me-auto flex items-center gap-2">
							<HistoryLink siteId={siteId} item={{ kind: "popup", id: popupId }} size="sm" />
							<Button variant="ghost" size="sm" className="text-destructive" onClick={() => setDeleting(true)}>
								<TrashIcon aria-hidden="true" />
								{t("popups.delete")}
							</Button>
						</div>
						<Button
							variant="outline"
							disabled={busy}
							onClick={() => void run((api) => api.popups.saveDraft({ siteId, popupId, popup: settings }))}
						>
							{t("popups.save")}
						</Button>
						<Button
							disabled={busy}
							onClick={() =>
								void run(async (api) => {
									await api.popups.saveDraft({ siteId, popupId, popup: settings });
									await api.popups.publish({ siteId, popupId });
								}, true)
							}
						>
							{t("popups.publish")}
						</Button>
					</>
				) : undefined
			}
		>
			<div className="@container/sheet grid min-w-0 gap-8">
				<p role="status" className="text-sm empty:hidden">
					{message}
				</p>
				<SheetSection id={`${uid}-content`} title={t("popups.content")} intro={t("popups.contentIntro")}>
					<div className="grid min-w-0 gap-4">
						<div className="grid min-w-0 gap-2">
							<label htmlFor={`${uid}-language`} className="text-sm font-medium">
								{t("popups.language")}
							</label>
							<NativeSelect
								className="w-full min-w-0 @lg/sheet:w-64"
								id={`${uid}-language`}
								value={view.content.language}
								onChange={async (e) => {
									const language = e.target.value;
									if (await coEdited.autosave.flush()) await onLanguage(language);
								}}
							>
								{languages.all.map((l) => (
									<NativeSelectOption key={l} value={l}>
										{l}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</div>
						<PresenceList participants={shared.participants} />
						<SharedDraftBanner status={shared.status} editable={shared.editable} />
						<SharedDraftStatus status={shared.status} editable={shared.editable} publishedBy={coEdited.publishedBy} />
						<fieldset
							className="min-w-0"
							disabled={coEdited.locked || !permissions.includes("entry.edit")}
							{...tracking}
						>
							<FieldValueList
								wrap={(field, control) => (
									<PresenceOutline place={field.key} participants={shared.participants}>
										{control}
									</PresenceOutline>
								)}
								fields={
									view.content.fields.map((f) => ({
										...f,
										label: t(`popups.fields.${f.key as "title"}`),
									})) as FieldDefinition[]
								}
								values={values}
								onChange={(key, value) => coEdited.change({ [key]: value })}
								context={{
									siteId,
									idPrefix: uid,
									language: view.content.language,
									defaultLanguage: languages.default,
									problems: [],
									relationships: {},
									media,
									onMediaChosen: (item) => setMedia((before) => ({ ...before, [item.id]: item })),
									markShared: true,
								}}
							/>
						</fieldset>
						<div className="flex flex-wrap gap-2">
							<Button
								variant="outline"
								disabled={busy || !permissions.includes("entry.edit")}
								onClick={() => void run(async () => {})}
							>
								{t("popups.saveContent")}
							</Button>
							{permissions.includes("entry.publish") ? (
								<Button
									variant="outline"
									disabled={busy}
									onClick={() =>
										void run(async (api) => {
											await api.popups.publishContent({ siteId, popupId });
										}, true)
									}
								>
									{t("popups.publishContent")}
								</Button>
							) : null}
							<HistoryLink siteId={siteId} item={{ kind: "popupContent", id: popupId }} />
							<SubmitForReview
								siteId={siteId}
								items={[{ kind: "popupContent", id: popupId }]}
								disabled={busy}
								flush={coEdited.autosave.flush}
								onSubmitted={() => router.invalidate()}
								onProblems={() => {}}
							/>
							<ReviewStatus siteId={siteId} review={view.content.review} onChanged={() => router.invalidate()} />
						</div>
					</div>
				</SheetSection>
				{structure ? (
					<>
						<SheetSection id={`${uid}-layout`} title={t("popups.layoutSection")} intro={t("popups.layoutIntro")}>
							<SettingsRows>
								<SettingsRow className={ROW} label={t("popups.build")} help={t("popups.buildHelp")}>
									<Link
										className={buttonVariants({ variant: "outline" })}
										to="/builder/$siteId/$"
										params={{ siteId, _splat: `component/${view.popup.componentId}` }}
									>
										<WrenchIcon aria-hidden="true" />
										{t("popups.build")}
									</Link>
								</SettingsRow>
								{select("layout", settings.layout, ["modal", "slide-in", "bar", "full-screen"], (v) =>
									setSettings((s) => ({ ...s, layout: v as typeof s.layout })),
								)}
								{settings.layout === "bar" ? (
									<>
										{select("barPosition", settings.barPosition, ["top", "bottom"], (v) =>
											setSettings((s) => ({ ...s, barPosition: v as typeof s.barPosition })),
										)}
										{select("barBehavior", settings.barBehavior, ["push", "overlay"], (v) =>
											setSettings((s) => ({ ...s, barBehavior: v as typeof s.barBehavior })),
										)}
									</>
								) : null}
								{select("animation", settings.animation, ["none", "fade", "slide", "zoom"], (v) =>
									setSettings((s) => ({ ...s, animation: v as typeof s.animation })),
								)}
								<SettingsRow className={ROW} label={t("popups.backdropClose")} htmlFor={`${uid}-backdropClose`}>
									<Switch
										id={`${uid}-backdropClose`}
										checked={settings.backdropClose}
										onCheckedChange={(backdropClose) => setSettings((s) => ({ ...s, backdropClose }))}
									/>
								</SettingsRow>
								{(["autoCloseSeconds", "afterSubmitCloseSeconds"] as const).map((key) => (
									<SettingsRow className={ROW} key={key} label={t(`popups.${key}`)} htmlFor={`${uid}-${key}`}>
										<Input
											id={`${uid}-${key}`}
											className="w-28"
											type="number"
											min={key === "autoCloseSeconds" ? 1 : 0}
											max={86400}
											value={settings[key] ?? ""}
											onChange={(e) =>
												setSettings((s) => ({
													...s,
													[key]: e.target.value === "" ? null : Number(e.target.value),
												}))
											}
										/>
									</SettingsRow>
								))}
								<SettingsRow className={ROW} label={t("popups.mainButton")} htmlFor={`${uid}-mainButton`}>
									<Input
										id={`${uid}-mainButton`}
										className="w-full font-mono @lg/sheet:w-64"
										value={settings.mainButton ?? ""}
										onChange={(e) => setSettings((s) => ({ ...s, mainButton: e.target.value || null }))}
									/>
								</SettingsRow>
							</SettingsRows>
						</SheetSection>
						<SheetSection
							id={`${uid}-triggers`}
							title={t("popups.triggers")}
							intro={t("popups.triggersIntro")}
							action={
								<Button
									variant="outline"
									size="sm"
									disabled={settings.additionalTriggers.length >= 6}
									onClick={() => {
										setTriggerKeys((keys) => [...keys, crypto.randomUUID()]);
										setSettings((s) => ({
											...s,
											additionalTriggers: [...s.additionalTriggers, { kind: "click" }],
										}));
									}}
								>
									<PlusIcon aria-hidden="true" />
									{t("popups.addTrigger")}
								</Button>
							}
						>
							<SettingsRows>
								<TriggerRow value={settings.trigger} onChange={(trigger) => setSettings((s) => ({ ...s, trigger }))} />
								{settings.additionalTriggers.map((trigger, index) => (
									<TriggerRow
										key={triggerKeys[index]}
										value={trigger}
										onChange={(next) =>
											setSettings((s) => ({
												...s,
												additionalTriggers: s.additionalTriggers.map((t, i) => (i === index ? next : t)),
											}))
										}
										onRemove={() => {
											setTriggerKeys((keys) => keys.filter((_, i) => i !== index));
											setSettings((s) => ({
												...s,
												additionalTriggers: s.additionalTriggers.filter((_, i) => i !== index),
											}));
										}}
									/>
								))}
							</SettingsRows>
						</SheetSection>
						<SheetSection id={`${uid}-rules`} title={t("popups.rules")} intro={t("popups.rulesIntro")}>
							<SettingsRows>
								<SettingsRow
									className={cn(ROW, "@lg/sheet:items-start")}
									label={t("popups.paths")}
									help={t("popups.ruleHelp.paths")}
									htmlFor={`${uid}-paths`}
								>
									<Textarea
										id={`${uid}-paths`}
										className="w-full font-mono @lg/sheet:w-64"
										value={settings.rules.paths.join("\n")}
										onChange={(e) => rules({ paths: e.target.value.split("\n").filter(Boolean) })}
									/>
								</SettingsRow>
								<SettingsRow
									className={cn(ROW, "@lg/sheet:items-start")}
									label={t("popups.excludePaths")}
									help={t("popups.ruleHelp.excludePaths")}
									htmlFor={`${uid}-excludePaths`}
								>
									<Textarea
										id={`${uid}-excludePaths`}
										className="w-full font-mono @lg/sheet:w-64"
										value={settings.rules.excludePaths.join("\n")}
										onChange={(e) => rules({ excludePaths: e.target.value.split("\n").filter(Boolean) })}
									/>
								</SettingsRow>
								{many("postTypes", postTypes, settings.rules.postTypeIds, (ids) => rules({ postTypeIds: ids }))}
								{many("excludePostTypes", postTypes, settings.rules.excludePostTypeIds, (ids) =>
									rules({ excludePostTypeIds: ids }),
								)}
								{many("entries", entryChoices, settings.rules.entryIds, (ids) => rules({ entryIds: ids }))}
								{many("excludeEntries", entryChoices, settings.rules.excludeEntryIds, (ids) =>
									rules({ excludeEntryIds: ids }),
								)}
								{many(
									"languages",
									languages.all.map((l) => ({ id: l, name: l })),
									settings.rules.languages,
									(ids) => rules({ languages: ids }),
								)}
								{many(
									"devices",
									["phone", "tablet", "desktop"].map((v) => ({ id: v, name: option(v) })),
									settings.rules.devices,
									(ids) => rules({ devices: ids as ("phone" | "tablet" | "desktop")[] }),
								)}
								{select("visitors", settings.rules.visitors, ["all", "new", "returning"], (v) =>
									rules({ visitors: v as "all" }),
								)}
								{select(
									"frequency",
									settings.frequency.kind,
									["page", "visit", "interval", "closed", "submitted"],
									(v) => setSettings((s) => ({ ...s, frequency: { ...s.frequency, kind: v as "page" } })),
								)}
								{settings.frequency.kind === "interval" ? (
									<SettingsRow className={ROW} label={t("popups.days")} htmlFor={`${uid}-days`}>
										<Input
											id={`${uid}-days`}
											className="w-28"
											type="number"
											min={1}
											value={settings.frequency.days}
											onChange={(e) =>
												setSettings((s) => ({
													...s,
													frequency: { ...s.frequency, days: Number(e.target.value) },
												}))
											}
										/>
									</SettingsRow>
								) : null}
							</SettingsRows>
						</SheetSection>
						<Checks checks={view.popup.checks} />
					</>
				) : null}
			</div>
			{deleting ? (
				<ConfirmDialog
					open
					onOpenChange={(open) => !open && setDeleting(false)}
					title={t("popups.deleteTitle", { name: view.popup.name })}
					confirm={t("popups.deleteConfirm")}
					onConfirm={async () => {
						try {
							if (!(await coEdited.autosave.flush())) return;
							const api = await getApi();
							const asked = await api.popups.delete({ siteId, popupId });
							if (!asked.deleted) await api.popups.delete({ siteId, popupId, confirmation: asked.confirmation.id });
							toast.success(t("popups.deleted", { name: view.popup.name }));
							onClose();
							await router.invalidate();
						} catch (error) {
							toast.error(t(errorMessage(error)));
						}
					}}
				>
					{t("popups.confirmDelete")}
				</ConfirmDialog>
			) : null}
		</PageSheet>
	);
}

/** A part of the sheet: its heading, one line about it, an action at its end, then its rows. */
function SheetSection({
	id,
	title,
	intro,
	action,
	children,
}: {
	id: string;
	title: string;
	intro?: string;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section aria-labelledby={id} className="grid min-w-0 gap-4">
			<div className="flex items-start gap-3 border-b pb-3">
				<div className="min-w-0 flex-1 space-y-1">
					<h3 id={id} className="text-base font-semibold">
						{title}
					</h3>
					{intro ? <p className="text-muted-foreground text-sm">{intro}</p> : null}
				</div>
				{action ? <div className="shrink-0">{action}</div> : null}
			</div>
			{children}
		</section>
	);
}

/** A rule's row whose control is a set of choices: a fieldset, its legend the row's label. */
function ChoiceRow({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
	const id = useId();
	return (
		<fieldset
			data-slot="settings-row"
			aria-describedby={help ? `${id}-help` : undefined}
			className="flex min-w-0 flex-col gap-2 py-4 first:pt-0 last:pb-0"
		>
			<legend className="float-start mb-1 w-full text-sm font-medium">{label}</legend>
			{help ? (
				<p id={`${id}-help`} className="text-muted-foreground -mt-1 text-[13px]">
					{help}
				</p>
			) : null}
			<div className="flex flex-wrap gap-x-5 gap-y-1">{children}</div>
		</fieldset>
	);
}

/** A Trigger as a row: what opens the Popup, its number or element, and Remove for an added one. */
function TriggerRow({
	value,
	onChange,
	onRemove,
}: {
	value: Trigger;
	onChange: (value: Trigger) => void;
	onRemove?: () => void;
}) {
	const t = useT();
	const id = useId();
	return (
		<div
			data-slot="settings-row"
			className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 @lg/sheet:flex-row @lg/sheet:flex-wrap @lg/sheet:items-end"
		>
			<div className="grid min-w-0 gap-2">
				<label htmlFor={`${id}-kind`} className="text-sm font-medium">
					{t("popups.trigger")}
				</label>
				<NativeSelect
					className="w-full min-w-0 @lg/sheet:w-56"
					id={`${id}-kind`}
					value={value.kind}
					onChange={(e) => {
						const kind = e.target.value;
						onChange(
							kind === "delay" || kind === "idle"
								? { kind, seconds: 5 }
								: kind === "scroll"
									? { kind, percent: 50 }
									: kind === "element"
										? { kind, selector: "#offer" }
										: { kind: kind as "click" },
						);
					}}
				>
					{(["load", "delay", "scroll", "element", "exit", "idle", "click"] as const).map((kind) => (
						<NativeSelectOption key={kind} value={kind}>
							{t(`popups.options.${kind}`)}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</div>
			{value.kind === "delay" || value.kind === "idle" ? (
				<div className="grid min-w-0 gap-2">
					<label htmlFor={`${id}-seconds`} className="text-sm font-medium">
						{t("popups.seconds")}
					</label>
					<Input
						id={`${id}-seconds`}
						className="w-28"
						type="number"
						min={value.kind === "idle" ? 1 : 0}
						max={86400}
						value={value.seconds}
						onChange={(e) => onChange({ ...value, seconds: Number(e.target.value) })}
					/>
				</div>
			) : null}
			{value.kind === "scroll" ? (
				<div className="grid min-w-0 gap-2">
					<label htmlFor={`${id}-percent`} className="text-sm font-medium">
						{t("popups.percent")}
					</label>
					<Input
						id={`${id}-percent`}
						className="w-28"
						type="number"
						min={1}
						max={100}
						value={value.percent}
						onChange={(e) => onChange({ ...value, percent: Number(e.target.value) })}
					/>
				</div>
			) : null}
			{value.kind === "element" ? (
				<div className="grid min-w-0 gap-2">
					<label htmlFor={`${id}-selector`} className="text-sm font-medium">
						{t("popups.element")}
					</label>
					<Input
						id={`${id}-selector`}
						className="w-full font-mono @lg/sheet:w-48"
						value={value.selector}
						onChange={(e) => onChange({ ...value, selector: e.target.value })}
					/>
				</div>
			) : null}
			{onRemove ? (
				<Button variant="outline" className="@lg/sheet:ms-auto" onClick={onRemove}>
					<TrashIcon aria-hidden="true" />
					{t("popups.removeTrigger")}
				</Button>
			) : null}
		</div>
	);
}
