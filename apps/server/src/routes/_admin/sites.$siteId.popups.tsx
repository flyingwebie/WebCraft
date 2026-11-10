import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { Button, buttonVariants } from "@webcraft/ui/components/button.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { useId, useState } from "react";
import { z } from "zod";
import { getApi } from "../../ui/api.ts";
import { Checks } from "../../ui/Checks.tsx";
import { useCoEditedValues } from "../../ui/co-editing/co-edited.ts";
import {
	PresenceList,
	PresenceOutline,
	SharedDraftBanner,
	SharedDraftStatus,
	usePlaceTracking,
} from "../../ui/co-editing/Presence.tsx";
import { documentValues, readFieldValues, withFieldValues } from "../../ui/co-editing/values.ts";
import { FieldValueList } from "../../ui/content/FieldValues.tsx";
import { loadMedia } from "../../ui/content/loaders.ts";
import type { FieldDefinition, FieldValues } from "../../ui/content/model.ts";
import { errorMessage } from "../../ui/errors.ts";
import { HistoryLink } from "../../ui/history/HistoryLink.tsx";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import type { MediaItem } from "../../ui/media/preview.ts";
import { PageHeader } from "../../ui/PageHeader.tsx";
import { ReviewStatus, SubmitForReview } from "../../ui/review/Review.tsx";

const search = z.object({ popup: z.string().optional(), language: z.string().optional() });
export const Route = createFileRoute("/_admin/sites/$siteId/popups")({
	staticData: { crumb: "popups.title" },
	validateSearch: search,
	loaderDeps: ({ search }) => search,
	loader: async ({ params, deps, context }) => {
		const api = await getApi();
		const siteId = params.siteId;
		const { popups } = await api.popups.list({ siteId });
		const selected = deps.popup && popups.some((p) => p.id === deps.popup) ? deps.popup : popups[0]?.id;
		const value = selected ? await api.popups.get({ siteId, popupId: selected, language: deps.language }) : null;
		const postTypes = context.place.permissions.includes("structure.edit")
			? (await api.postTypes.list({ siteId })).postTypes
			: [];
		const entries = (await Promise.all(postTypes.map((p) => api.entries.list({ siteId, postTypeId: p.id })))).flatMap(
			(result) => result.entries.map((e) => ({ id: e.id, title: e.draft.title })),
		);
		const media = value ? await loadMedia(api, siteId, value.content.fields, value.content.draft.values) : {};
		return { popups, value, postTypes, entries, media };
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "popups.title") }] }),
	component: PopupsPage,
});
type View = Awaited<ReturnType<ApiClient["popups"]["get"]>>;
function PopupsPage() {
	const t = useT();
	const router = useRouter();
	const navigate = useNavigate();
	const { siteId } = Route.useParams();
	const data = Route.useLoaderData();
	const { place } = Route.useRouteContext();
	const [name, setName] = useState("");
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const nameId = useId();
	if (place.level !== "site") return null;
	const structure = place.permissions.includes("structure.edit");
	return (
		<>
			<PageHeader heading={t("popups.title")} />
			{structure ? (
				<form
					className="mb-6 flex max-w-xl flex-wrap items-end gap-3"
					onSubmit={async (e) => {
						e.preventDefault();
						setBusy(true);
						try {
							const api = await getApi();
							const { popup } = await api.popups.create({ siteId, name });
							setName("");
							await router.invalidate();
							await navigate({ to: "/sites/$siteId/popups", params: { siteId }, search: { popup: popup.id } });
						} catch (error) {
							setMessage(t(errorMessage(error)));
						} finally {
							setBusy(false);
						}
					}}
				>
					<label className="grid min-w-0 gap-2" htmlFor={nameId}>
						{t("popups.name")}
						<Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
					</label>
					<Button disabled={busy}>{t("popups.new")}</Button>
				</form>
			) : null}
			<p role="status">{message}</p>
			<nav aria-label={t("popups.title")} className="mb-6 flex flex-wrap gap-4">
				{data.popups.map((p) => (
					<Link
						key={p.id}
						to="/sites/$siteId/popups"
						params={{ siteId }}
						search={{ popup: p.id }}
						aria-current={data.value?.popup.id === p.id ? "page" : undefined}
					>
						{p.name}
					</Link>
				))}
			</nav>
			{data.value ? (
				<PopupEditor
					key={`${data.value.popup.id}-${data.value.content.language}`}
					view={data.value}
					knownMedia={data.media}
					siteId={siteId}
					structure={structure}
					permissions={place.permissions}
					languages={place.languages}
					postTypes={data.postTypes}
					entries={data.entries}
				/>
			) : null}
		</>
	);
}
function PopupEditor({
	view,
	knownMedia,
	siteId,
	structure,
	permissions,
	languages,
	postTypes,
	entries,
}: {
	view: View;
	knownMedia: Readonly<Record<string, MediaItem>>;
	siteId: string;
	structure: boolean;
	permissions: readonly string[];
	languages: { default: string; all: readonly string[] };
	postTypes: { id: string; name: string }[];
	entries: { id: string; title: string }[];
}) {
	const t = useT();
	const router = useRouter();
	const navigate = useNavigate();
	const uid = useId();
	const [settings, setSettings] = useState(view.popup.draft);
	const [triggerKeys, setTriggerKeys] = useState(() =>
		view.popup.draft.additionalTriggers.map(() => crypto.randomUUID()),
	);
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const [confirmation, setConfirmation] = useState<string>();
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
			if (!confirmation) setMessage(t(published ? "popups.published" : "popups.saved"));
			await router.invalidate();
		} catch (error) {
			setMessage(t(errorMessage(error)));
		} finally {
			setBusy(false);
		}
	};
	const option = (value: string) => t(`popups.options.${value as "modal"}`);
	const select = (
		label: "layout" | "trigger" | "visitors" | "frequency" | "animation" | "barPosition" | "barBehavior",
		value: string,
		choices: string[],
		change: (value: string) => void,
	) => (
		<div className="grid min-w-0 gap-2">
			<label htmlFor={`${uid}-${label}`}>{t(`popups.${label}`)}</label>
			<NativeSelect
				className="w-full min-w-0"
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
		</div>
	);
	const many = (
		label: "postTypes" | "entries" | "languages" | "devices" | "excludePostTypes" | "excludeEntries",
		choices: { id: string; name: string }[],
		selected: string[],
		change: (ids: string[]) => void,
	) => (
		<fieldset className="grid min-w-0 gap-2 rounded border p-4">
			<legend>{t(`popups.${label}`)}</legend>
			{choices.map((v) => (
				<label key={v.id} className="flex min-h-9 items-center gap-2">
					<input
						className="size-5"
						type="checkbox"
						checked={selected.includes(v.id)}
						onChange={(e) => change(e.target.checked ? [...selected, v.id] : selected.filter((id) => id !== v.id))}
					/>
					{v.name}
				</label>
			))}
		</fieldset>
	);
	const remove = async () => {
		setBusy(true);
		try {
			if (!(await coEdited.autosave.flush())) return;
			const api = await getApi();
			const result = await api.popups.delete({ siteId, popupId, confirmation });
			if (result.deleted) {
				await router.invalidate();
				await navigate({ to: "/sites/$siteId/popups", params: { siteId }, search: {} });
			} else {
				setConfirmation(result.confirmation.id);
				setMessage(t("popups.confirmDelete"));
			}
		} catch (error) {
			setMessage(t(errorMessage(error)));
		} finally {
			setBusy(false);
		}
	};
	const rules = (patch: Partial<typeof settings.rules>) =>
		setSettings((s) => ({ ...s, rules: { ...s.rules, ...patch } }));
	return (
		<div className="grid max-w-4xl min-w-0 gap-8">
			<h2 className="text-xl font-semibold">{view.popup.name}</h2>
			<p role="status">{message}</p>
			<section aria-labelledby={`${uid}-content`} className="grid min-w-0 gap-5">
				<h3 id={`${uid}-content`}>{t("popups.content")}</h3>
				<div className="grid min-w-0 gap-2">
					<label htmlFor={`${uid}-language`}>{t("popups.languages")}</label>
					<NativeSelect
						className="w-full min-w-0"
						id={`${uid}-language`}
						value={view.content.language}
						onChange={async (e) => {
							const language = e.target.value;
							if (await coEdited.autosave.flush())
								await navigate({
									to: "/sites/$siteId/popups",
									params: { siteId },
									search: { popup: popupId, language },
								});
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
				<fieldset className="min-w-0" disabled={coEdited.locked || !permissions.includes("entry.edit")} {...tracking}>
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
				<div className="flex flex-wrap gap-3">
					<Button disabled={busy || !permissions.includes("entry.edit")} onClick={() => void run(async () => {})}>
						{t("popups.save")}
					</Button>
					{permissions.includes("entry.publish") ? (
						<Button
							disabled={busy}
							onClick={() =>
								void run(async (api) => {
									await api.popups.publishContent({ siteId, popupId });
								}, true)
							}
						>
							{t("popups.publish")}
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
			</section>
			{structure ? (
				<section className="grid min-w-0 gap-5" aria-labelledby={`${uid}-structure`}>
					<h3 id={`${uid}-structure`}>{t("popups.structure")}</h3>
					<Link
						className={buttonVariants({ variant: "outline" })}
						to="/builder/$siteId/$"
						params={{ siteId, _splat: `component/${view.popup.componentId}` }}
					>
						{t("popups.build")}
					</Link>
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
					<TriggerControls value={settings.trigger} onChange={(trigger) => setSettings((s) => ({ ...s, trigger }))} />
					{settings.additionalTriggers.map((trigger, index) => (
						<div className="grid min-w-0 gap-3 rounded border p-4" key={triggerKeys[index]}>
							<TriggerControls
								value={trigger}
								onChange={(next) =>
									setSettings((s) => ({
										...s,
										additionalTriggers: s.additionalTriggers.map((t, i) => (i === index ? next : t)),
									}))
								}
							/>
							<Button
								variant="outline"
								onClick={() => {
									setTriggerKeys((keys) => keys.filter((_, i) => i !== index));
									setSettings((s) => ({
										...s,
										additionalTriggers: s.additionalTriggers.filter((_, i) => i !== index),
									}));
								}}
							>
								{t("popups.removeTrigger")}
							</Button>
						</div>
					))}
					<Button
						variant="outline"
						disabled={settings.additionalTriggers.length >= 6}
						onClick={() => {
							setTriggerKeys((keys) => [...keys, crypto.randomUUID()]);
							setSettings((s) => ({ ...s, additionalTriggers: [...s.additionalTriggers, { kind: "click" }] }));
						}}
					>
						{t("popups.addTrigger")}
					</Button>
					{select("animation", settings.animation, ["none", "fade", "slide", "zoom"], (v) =>
						setSettings((s) => ({ ...s, animation: v as typeof s.animation })),
					)}
					<label className="flex min-h-9 items-center gap-2">
						<input
							className="size-5"
							type="checkbox"
							checked={settings.backdropClose}
							onChange={(e) => setSettings((s) => ({ ...s, backdropClose: e.target.checked }))}
						/>
						{t("popups.backdropClose")}
					</label>
					{(["autoCloseSeconds", "afterSubmitCloseSeconds"] as const).map((key) => (
						<label className="grid min-w-0 gap-2" key={key} htmlFor={`${uid}-${key}`}>
							{t(`popups.${key}`)}
							<Input
								id={`${uid}-${key}`}
								type="number"
								min={key === "autoCloseSeconds" ? 1 : 0}
								max={86400}
								value={settings[key] ?? ""}
								onChange={(e) =>
									setSettings((s) => ({ ...s, [key]: e.target.value === "" ? null : Number(e.target.value) }))
								}
							/>
						</label>
					))}
					<label className="grid min-w-0 gap-2" htmlFor={`${uid}-mainButton`}>
						{t("popups.mainButton")}
						<Input
							id={`${uid}-mainButton`}
							value={settings.mainButton ?? ""}
							onChange={(e) => setSettings((s) => ({ ...s, mainButton: e.target.value || null }))}
						/>
					</label>
					<Checks checks={view.popup.checks} />
					<label className="grid min-w-0 gap-2" htmlFor={`${uid}-paths`}>
						{t("popups.paths")}
						<Textarea
							id={`${uid}-paths`}
							value={settings.rules.paths.join("\n")}
							onChange={(e) => rules({ paths: e.target.value.split("\n").filter(Boolean) })}
						/>
					</label>
					<label className="grid min-w-0 gap-2" htmlFor={`${uid}-excludePaths`}>
						{t("popups.excludePaths")}
						<Textarea
							id={`${uid}-excludePaths`}
							value={settings.rules.excludePaths.join("\n")}
							onChange={(e) => rules({ excludePaths: e.target.value.split("\n").filter(Boolean) })}
						/>
					</label>
					{many("excludePostTypes", postTypes, settings.rules.excludePostTypeIds, (ids) =>
						rules({ excludePostTypeIds: ids }),
					)}
					{many(
						"excludeEntries",
						entries.map((e) => ({ id: e.id, name: e.title })),
						settings.rules.excludeEntryIds,
						(ids) => rules({ excludeEntryIds: ids }),
					)}
					{many("postTypes", postTypes, settings.rules.postTypeIds, (ids) => rules({ postTypeIds: ids }))}
					{many(
						"entries",
						entries.map((e) => ({ id: e.id, name: e.title })),
						settings.rules.entryIds,
						(ids) => rules({ entryIds: ids }),
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
					{select("frequency", settings.frequency.kind, ["page", "visit", "interval", "closed", "submitted"], (v) =>
						setSettings((s) => ({ ...s, frequency: { ...s.frequency, kind: v as "page" } })),
					)}
					{settings.frequency.kind === "interval" ? (
						<label className="grid min-w-0 gap-2" htmlFor={`${uid}-days`}>
							{t("popups.days")}
							<Input
								id={`${uid}-days`}
								type="number"
								min={1}
								value={settings.frequency.days}
								onChange={(e) =>
									setSettings((s) => ({ ...s, frequency: { ...s.frequency, days: Number(e.target.value) } }))
								}
							/>
						</label>
					) : null}
					<div className="flex flex-wrap gap-3">
						<Button
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
						<HistoryLink siteId={siteId} item={{ kind: "popup", id: popupId }} />
						<Button variant="destructive" disabled={busy} onClick={() => void remove()}>
							{confirmation ? t("popups.confirm") : t("popups.delete")}
						</Button>
					</div>
				</section>
			) : null}
		</div>
	);
}

function TriggerControls({
	value,
	onChange,
}: {
	value: View["popup"]["draft"]["trigger"];
	onChange: (value: View["popup"]["draft"]["trigger"]) => void;
}) {
	const t = useT();
	const id = useId();
	return (
		<fieldset className="grid min-w-0 gap-3">
			<div className="grid min-w-0 gap-2">
				<label htmlFor={`${id}-kind`}>{t("popups.trigger")}</label>
				<NativeSelect
					className="w-full min-w-0"
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
				<label className="grid min-w-0 gap-2" htmlFor={`${id}-seconds`}>
					{t("popups.seconds")}
					<Input
						id={`${id}-seconds`}
						type="number"
						min={value.kind === "idle" ? 1 : 0}
						max={86400}
						value={value.seconds}
						onChange={(e) => onChange({ ...value, seconds: Number(e.target.value) })}
					/>
				</label>
			) : null}
			{value.kind === "scroll" ? (
				<label className="grid min-w-0 gap-2" htmlFor={`${id}-percent`}>
					{t("popups.percent")}
					<Input
						id={`${id}-percent`}
						type="number"
						min={1}
						max={100}
						value={value.percent}
						onChange={(e) => onChange({ ...value, percent: Number(e.target.value) })}
					/>
				</label>
			) : null}
			{value.kind === "element" ? (
				<label className="grid min-w-0 gap-2" htmlFor={`${id}-selector`}>
					{t("popups.element")}
					<Input
						id={`${id}-selector`}
						value={value.selector}
						onChange={(e) => onChange({ ...value, selector: e.target.value })}
					/>
				</label>
			) : null}
		</fieldset>
	);
}
