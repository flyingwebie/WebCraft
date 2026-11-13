import { Link, useNavigate } from "@tanstack/react-router";
import { NEW_FIELD_TYPES, type NewFieldType, type SourceValueKind, takes } from "@webcraft/core/import-rules";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { cn } from "@webcraft/ui/lib/utils.ts";
import {
	ArrowLeftIcon,
	ArrowRightIcon,
	CalendarClockIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	CircleAlertIcon,
	CornerDownRightIcon,
	FileLockIcon,
	LoaderIcon,
	PlayIcon,
	RefreshCwIcon,
	ShieldCheckIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { Tabs } from "../Tabs.tsx";
import { LiveConnection } from "./LiveConnection.tsx";
import {
	blockSummary,
	type ImportView,
	nameOfFile,
	type PreviewEntryView,
	type SourceFileView,
	type SourcePreviewView,
	type SourceSampleView,
	type SourceSettings,
	sourceSettingWording,
	uploadRefusal,
} from "./model.ts";
import { Note } from "./Note.tsx";
import { RemoveImport } from "./RemoveImport.tsx";
import { type ImportStep, Stepper } from "./Stepper.tsx";

type Step = Extract<ImportStep, "source" | "map" | "preview">;

/** How often a file being surveyed, or a preview being worked out, is asked about again. */
const POLL_MS = 1500;

/** What the Source step knows of a Module's import source. */
export type SourceChoice = {
	kind?: "file" | "live";
	id: string;
	label: string;
	description: string;
	maxBytes: number;
	extensions: readonly string[];
};

/**
 * The first three steps of an Import from a Module's source (a WordPress export file): Source (the
 * file, uploaded in parts that can go on where they stopped, then surveyed by the worker), Map (each
 * type of item to a Post Type, a new one or nowhere, and each key to a Field, with a live sample
 * Entry; mapping variant B) and Preview (real Entries with their Blocks, Import leftovers and Redirect
 * rules, worked out without writing or fetching anything), then Start.
 */
export function SourceImportFlow({
	siteId,
	source,
	chooser,
	postTypes,
	redirectsOn,
	existing,
}: {
	siteId: string;
	source: SourceChoice;
	/** The Source step's list of sources, to go back to another. */
	chooser: ReactNode;
	postTypes: readonly { id: string; name: string; builtIn: string | null }[];
	redirectsOn: boolean;
	existing: ImportView | null;
}) {
	const t = useT();
	const navigate = useNavigate();
	const ids = useId();
	const heading = useRef<HTMLHeadingElement>(null);
	const [step, setStep] = useState<Step>("source");
	const [connectedId, setConnectedId] = useState<string | undefined>(existing?.id);
	const [name, setName] = useState(existing?.name ?? "");
	const [file, setFile] = useState<SourceFileView | null>(null);
	const [sent, setSent] = useState(0);
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState<{ key: MessageKey; values?: Record<string, string | number> } | null>(null);
	const [settings, setSettings] = useState<SourceSettings | null>(null);
	const [busy, setBusy] = useState(false);

	// A new step starts with its heading focused, so a screen reader hears where it is.
	const shownStep = useRef(step);
	useEffect(() => {
		if (shownStep.current === step) return;
		shownStep.current = step;
		heading.current?.focus();
	}, [step]);

	// A file being surveyed is asked about until the worker read it.
	useEffect(() => {
		if (file?.status !== "surveying") return;
		const timer = setInterval(async () => {
			try {
				const api = await getApi();
				const { file: latest } = await api.imports.file({ siteId, fileId: file.id });
				if (latest.status !== "surveying") setFile(latest);
			} catch {
				// Asked again at the next tick.
			}
		}, POLL_MS);
		return () => clearInterval(timer);
	}, [siteId, file?.id, file?.status]);

	const upload = async (chosen: File | undefined) => {
		if (!chosen) return;
		setUploading(true);
		setError(null);
		try {
			const api = await getApi();
			// The same file again goes on where its upload stopped.
			let view =
				file && file.status === "uploading" && file.fileName === chosen.name && file.sizeBytes === chosen.size
					? (await api.imports.file({ siteId, fileId: file.id })).file
					: (await api.imports.startUpload({ siteId, source: source.id, fileName: chosen.name, size: chosen.size }))
							.file;
			setFile(view);
			const hashes: Uint8Array[] = [];
			for (let offset = 0; offset < chosen.size; offset += view.partBytes) {
				const part = new File([chosen.slice(offset, offset + view.partBytes)], "part");
				const bytes = new Uint8Array(await part.arrayBuffer());
				const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
				hashes.push(hash);
				if (offset + bytes.length <= view.receivedBytes) continue;
				for (let attempt = 1; ; attempt++) {
					try {
						view = (await api.imports.uploadPart({ siteId, fileId: view.id, offset, sha256: hex(hash), part })).file;
						break;
					} catch (failure) {
						if (attempt >= 3) throw failure;
					}
				}
				setSent(offset + bytes.length);
				setFile(view);
			}
			const all = new Uint8Array(hashes.length * 32);
			for (const [index, hash] of hashes.entries()) all.set(hash, index * 32);
			const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", all)));
			view = (await api.imports.finishUpload({ siteId, fileId: view.id, sha256: digest })).file;
			setFile(view);
			if (!name.trim()) setName(nameOfFile(chosen.name));
		} catch (failure) {
			setError(uploadRefusal(failure) ?? { key: errorMessage(failure) });
		} finally {
			setUploading(false);
		}
	};

	const toMap = () => {
		if (file?.status !== "ready" || !file.suggested) {
			setError({ key: "imports.sourceFlow.chooseFile" });
			return;
		}
		if (!name.trim()) {
			setError({ key: "imports.flow.nameRequired" });
			return;
		}
		setError(null);
		if (!settings)
			setSettings(existing ? mergedSettings(existing.settings as SourceSettings, file.suggested) : file.suggested);
		setStep("map");
	};

	const start = async () => {
		if (!file || !settings) return;
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			const importId = connectedId
				? (await api.imports.update({ siteId, importId: connectedId, name: name.trim(), settings })).import.id
				: (await api.imports.create({ siteId, name: name.trim(), source: source.id, settings })).import.id;
			const { run } = await api.imports.start({ siteId, importId, fileId: file.id });
			await navigate({
				to: "/sites/$siteId/imports/$importId/runs/$runId",
				params: { siteId, importId, runId: run.id },
			});
		} catch (failure) {
			setError({ key: errorMessage(failure) });
			setBusy(false);
		}
	};

	const steps: Record<Step, { intro: string; next: ReactNode; onNext(): void; disabled: boolean }> = {
		source: {
			intro: t("imports.flow.sourceIntro"),
			next: (
				<>
					<ArrowRightIcon className="rtl:rotate-180" aria-hidden="true" />
					{t("imports.flow.toMap")}
				</>
			),
			onNext: toMap,
			disabled: uploading,
		},
		map: {
			intro: t("imports.sourceFlow.mapIntro"),
			next: (
				<>
					<ArrowRightIcon className="rtl:rotate-180" aria-hidden="true" />
					{t("imports.flow.toPreview")}
				</>
			),
			onNext: () => setStep("preview"),
			disabled: false,
		},
		preview: {
			intro: t("imports.flow.previewIntro"),
			next: (
				<>
					{busy ? <LoaderIcon className="animate-spin" aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
					{t("imports.flow.start")}
				</>
			),
			onNext: () => void start(),
			disabled: busy,
		},
	};
	const current = steps[step];
	const back: Step | null = step === "map" ? "source" : step === "preview" ? "map" : null;
	const percent =
		file && file.sizeBytes > 0 ? Math.floor((Math.max(sent, file.receivedBytes) / file.sizeBytes) * 100) : 0;

	return (
		<div className="grid gap-8">
			<header className="flex flex-wrap items-center gap-x-6 gap-y-4 border-b pb-6">
				<Button
					variant="ghost"
					size="icon"
					render={<Link to="/sites/$siteId/imports" params={{ siteId }} />}
					aria-label={t("imports.flow.backToList")}
				>
					<ArrowLeftIcon className="rtl:rotate-180" aria-hidden="true" />
				</Button>
				<div className="grid min-w-48 flex-1 gap-1">
					<h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
						{existing?.name ?? (step === "source" ? t("imports.flow.newTitle") : name || t("imports.flow.newTitle"))}
					</h1>
					<p className="text-muted-foreground text-sm">
						{step === "source" ? current.intro : `${source.label} · ${file?.fileName ?? ""}`}
					</p>
				</div>
				<Stepper current={step} />
				<div className="flex items-center gap-2">
					{back ? (
						<Button variant="ghost" onClick={() => setStep(back)}>
							{t("imports.flow.back")}
						</Button>
					) : (
						<Button variant="ghost" render={<Link to="/sites/$siteId/imports" params={{ siteId }} />}>
							{t("imports.flow.cancel")}
						</Button>
					)}
					<Button onClick={current.onNext} disabled={current.disabled}>
						{current.next}
					</Button>
				</div>
			</header>

			{error ? (
				<FieldError id={`${ids}-error`} className="max-w-3xl">
					{t(error.key, error.values)}
				</FieldError>
			) : null}

			<div className={cn("grid gap-8 lg:grid-cols-[16rem_minmax(0,1fr)_18rem]", step !== "source" && "hidden")}>
				{chooser}
				<section aria-labelledby={`${ids}-file-title`} className="grid content-start gap-6 rounded-lg border p-6">
					<div className="grid gap-1">
						<h2 id={`${ids}-file-title`} className="text-lg font-semibold">
							{source.label}
						</h2>
						<p className="text-muted-foreground text-sm">
							{t(source.kind === "live" ? "imports.live.intro" : "imports.sourceFlow.fileIntro")}
						</p>
					</div>
					<Field>
						<FieldLabel htmlFor={`${ids}-name`}>{t("imports.flow.name")}</FieldLabel>
						<Input
							id={`${ids}-name`}
							value={name}
							maxLength={200}
							aria-describedby={`${ids}-name-help`}
							onChange={(event) => setName(event.target.value)}
						/>
						<FieldDescription id={`${ids}-name-help`}>{t("imports.flow.nameHelp")}</FieldDescription>
					</Field>
					{source.kind === "live" ? (
						<LiveConnection
							siteId={siteId}
							source={source.id}
							name={name}
							existing={existing}
							onBusy={setUploading}
							onChange={(next, id) => {
								setFile(next);
								if (id) setConnectedId(id);
								setSettings(null);
							}}
						/>
					) : (
						<Field>
							<FieldLabel htmlFor={`${ids}-file`}>{t("imports.sourceFlow.file")}</FieldLabel>
							<Input
								id={`${ids}-file`}
								type="file"
								accept={source.extensions.join(",")}
								disabled={uploading}
								aria-describedby={`${ids}-file-help`}
								onChange={(event) => {
									void upload(event.target.files?.[0]);
									event.target.value = "";
								}}
							/>
							<FieldDescription id={`${ids}-file-help`}>
								{existing
									? t("imports.sourceFlow.fileAgain")
									: t("imports.sourceFlow.fileHelp", { gigabytes: Math.round(source.maxBytes / 1024 ** 3) })}
							</FieldDescription>
						</Field>
					)}
					{connectedId && source.kind === "live" ? <RemoveImport siteId={siteId} importId={connectedId} /> : null}
					{file ? (
						<FileStatus file={file} percent={percent} uploading={uploading} onRetry={() => setError(null)} />
					) : null}
				</section>
				<aside aria-labelledby={`${ids}-know`} className="grid content-start gap-3">
					<h2 id={`${ids}-know`} className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
						{t("imports.flow.goodToKnow")}
					</h2>
					<Note icon={<FileLockIcon className="size-4" aria-hidden="true" />}>
						{t(source.kind === "live" ? "imports.live.loginHelp" : "imports.sourceFlow.notePrivate")}
					</Note>
					<Note icon={<CalendarClockIcon className="size-4" aria-hidden="true" />}>{t("imports.flow.noteKept")}</Note>
					{redirectsOn ? (
						<Note icon={<CornerDownRightIcon className="size-4" aria-hidden="true" />}>
							{t("imports.sourceFlow.noteRedirects")}
						</Note>
					) : (
						<Warning>{t("imports.sourceFlow.redirectsOff")}</Warning>
					)}
					<Note icon={<ShieldCheckIcon className="size-4" aria-hidden="true" />}>{t("imports.flow.noteDrafts")}</Note>
				</aside>
			</div>

			{step === "map" && file?.survey && settings ? (
				<MapStep
					siteId={siteId}
					file={file}
					settings={settings}
					postTypes={postTypes}
					onChange={setSettings}
					importId={connectedId ?? null}
				/>
			) : null}

			{step === "preview" && file && settings ? (
				<PreviewStep
					siteId={siteId}
					fileId={file.id}
					settings={settings}
					importId={connectedId ?? null}
					onError={(key) => setError({ key })}
				/>
			) : null}
		</div>
	);
}

/** The settings an Import kept, with the types and keys a new file adds taken from the suggestion. */
function mergedSettings(kept: SourceSettings, suggested: SourceSettings): SourceSettings {
	const types = suggested.types.map((type) => {
		const own = kept.types.find((each) => each.type === type.type);
		if (!own) return type;
		const keys = type.keys.map((key) => own.keys.find((each) => each.key === key.key) ?? key);
		return { ...own, keys };
	});
	return { language: kept.language, types };
}

/** An uploaded file: how much came, then the survey's state. */
function FileStatus({
	file,
	percent,
	uploading,
	onRetry,
}: {
	file: SourceFileView;
	percent: number;
	uploading: boolean;
	onRetry(): void;
}) {
	const t = useT();
	if (file.status === "uploading") {
		return (
			<div className="grid gap-2">
				<div
					role="progressbar"
					aria-label={t("imports.sourceFlow.uploadLabel")}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={percent}
					aria-valuetext={t("imports.sourceFlow.uploaded", { percent })}
					className="bg-muted h-2 overflow-hidden rounded-full"
				>
					<div className="bg-primary h-full transition-[width]" style={{ width: `${percent}%` }} />
				</div>
				<p className="text-muted-foreground flex items-center gap-2 text-sm" aria-live="polite">
					{uploading ? <LoaderIcon className="size-4 animate-spin" aria-hidden="true" /> : null}
					{uploading ? t("imports.sourceFlow.uploaded", { percent }) : t("imports.sourceFlow.resume", { percent })}
				</p>
				{uploading ? null : (
					<Button variant="outline" size="sm" className="justify-self-start" onClick={onRetry}>
						<RefreshCwIcon aria-hidden="true" />
						{t("imports.sourceFlow.chooseAgain")}
					</Button>
				)}
			</div>
		);
	}
	if (file.status === "surveying") {
		return (
			<p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
				<LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
				{t("imports.sourceFlow.surveying")}
			</p>
		);
	}
	if (file.status === "refused") {
		return (
			<p className="text-destructive flex items-start gap-2 text-sm" role="alert">
				<CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
				{t(file.source.endsWith(".live") ? "imports.live.failed" : refusalKey(file.refusal?.code))}
			</p>
		);
	}
	return (
		<div
			className="grid gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100"
			role="status"
		>
			<p className="font-medium">{t("imports.sourceFlow.read", { name: file.fileName })}</p>
			<p>
				{(file.survey?.types ?? [])
					.map((type) => t("imports.sourceFlow.typeCount", { label: type.label, count: type.count }))
					.join(" · ")}
			</p>
		</div>
	);
}

function refusalKey(code: string | undefined): MessageKey {
	switch (code) {
		case "doctype":
		case "notExport":
		case "xml":
		case "encoding":
		case "itemTooLarge":
		case "valueTooLarge":
		case "source":
			return `imports.sourceFlow.refused.${code}`;
		default:
			return "imports.sourceFlow.refused.error";
	}
}

function Warning({ children }: { children: ReactNode }) {
	return (
		<p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
			<TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			{children}
		</p>
	);
}

// ---------------------------------------------------------------------------------------------------
// Map

type SurveyType = NonNullable<SourceFileView["survey"]>["types"][number];
type TypeSettings = SourceSettings["types"][number];
type KeyTarget = TypeSettings["keys"][number]["to"];
type PostTypeFields = { id: string; fields: { key: string; label: string; type: string }[] };

/**
 * Map, variant B: the file's types on the start side (each with where it goes), the chosen type's
 * keys in the middle (each into a Field, a new one, the title, the slug, an SEO field, or skipped),
 * and a live sample Entry on the end side, read with the mapping as it is.
 */
function MapStep({
	siteId,
	file,
	settings,
	postTypes,
	onChange,
	importId,
}: {
	siteId: string;
	file: SourceFileView;
	settings: SourceSettings;
	postTypes: readonly { id: string; name: string; builtIn: string | null }[];
	onChange(settings: SourceSettings): void;
	importId: string | null;
}) {
	const t = useT();
	const ids = useId();
	const types = file.survey?.types ?? [];
	const [selected, setSelected] = useState(types[0]?.key ?? "");
	const [fields, setFields] = useState<Map<string, PostTypeFields>>(new Map());
	const type = types.find((each) => each.key === selected);
	const mapped = settings.types.find((each) => each.type === selected);

	// The Fields of the Post Types the types go into, for the keys' choices.
	const wanted = [
		...new Set(
			settings.types.flatMap((each) =>
				each.to && typeof each.to === "object" && "postTypeId" in each.to ? [each.to.postTypeId] : [],
			),
		),
	];
	const wantedKey = wanted.join(",");
	useEffect(() => {
		let current = true;
		void (async () => {
			const api = await getApi();
			const found = new Map<string, PostTypeFields>();
			for (const postTypeId of wantedKey.split(",").filter(Boolean)) {
				const { postType } = await api.postTypes.get({ siteId, postTypeId });
				found.set(postTypeId, { id: postTypeId, fields: postType.fields });
			}
			if (current) setFields(found);
		})();
		return () => {
			current = false;
		};
	}, [siteId, wantedKey]);

	const change = (next: TypeSettings) =>
		onChange({ ...settings, types: settings.types.map((each) => (each.type === next.type ? next : each)) });

	return (
		<div className="grid gap-6 xl:grid-cols-[17rem_minmax(0,1fr)_20rem]">
			<nav aria-labelledby={`${ids}-types`} className="grid content-start gap-2">
				<h2 id={`${ids}-types`} className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
					{t("imports.sourceFlow.types")}
				</h2>
				<ul className="grid gap-1">
					{types.map((each) => {
						const own = settings.types.find((setting) => setting.type === each.key);
						return (
							<li key={each.key}>
								<button
									type="button"
									aria-current={each.key === selected ? "true" : undefined}
									onClick={() => setSelected(each.key)}
									className={cn(
										"hover:bg-muted/60 focus-visible:ring-ring/50 grid w-full gap-0.5 rounded-lg border p-3 text-start outline-none focus-visible:ring-3",
										each.key === selected ? "border-primary border-2" : "border-transparent",
									)}
								>
									<span className="flex items-center justify-between gap-2 font-medium">
										<span>
											{each.label} · {each.count}
										</span>
										{own?.to && typeof own.to === "object" && "newPostType" in own.to ? (
											<Badge variant="outline">{t("imports.sourceFlow.new")}</Badge>
										) : null}
									</span>
									<span className="text-muted-foreground text-sm">{destinationText(t, own, postTypes)}</span>
								</button>
							</li>
						);
					})}
				</ul>
			</nav>

			{type && mapped ? (
				<section aria-labelledby={`${ids}-keys`} className="grid content-start gap-4">
					<div className="flex flex-wrap items-end gap-3">
						<h2 id={`${ids}-keys`} className="text-xl font-semibold">
							{type.label}
						</h2>
						<Field className="min-w-60 flex-1">
							<FieldLabel htmlFor={`${ids}-into`}>{t("imports.sourceFlow.goInto", { label: type.label })}</FieldLabel>
							<NativeSelect
								id={`${ids}-into`}
								className="w-full"
								value={destinationValue(mapped.to)}
								onChange={(event) => change(withDestination(mapped, event.target.value, type))}
							>
								{type.holds === "media" ? (
									<NativeSelectOption value="media">{t("imports.sourceFlow.mediaLibrary")}</NativeSelectOption>
								) : (
									<>
										{postTypes.map((postType) => (
											<NativeSelectOption key={postType.id} value={`postType:${postType.id}`}>
												{postType.name}
											</NativeSelectOption>
										))}
										<NativeSelectOption value="new">
											{t("imports.sourceFlow.newPostType", {
												name:
													mapped.to && typeof mapped.to === "object" && "newPostType" in mapped.to
														? mapped.to.newPostType.name
														: type.label,
											})}
										</NativeSelectOption>
									</>
								)}
								<NativeSelectOption value="skip">{t("imports.map.skip")}</NativeSelectOption>
							</NativeSelect>
						</Field>
					</div>
					{mapped.to && typeof mapped.to === "object" && "newPostType" in mapped.to ? (
						<Field>
							<FieldLabel htmlFor={`${ids}-new-name`}>{t("imports.sourceFlow.newPostTypeName")}</FieldLabel>
							<Input
								id={`${ids}-new-name`}
								value={mapped.to.newPostType.name}
								maxLength={100}
								onChange={(event) => change({ ...mapped, to: { newPostType: { name: event.target.value } } })}
							/>
						</Field>
					) : null}
					{type.holds === "media" ? (
						<p className="text-muted-foreground text-sm">{t("imports.sourceFlow.mediaHelp")}</p>
					) : mapped.to === null ? (
						<p className="text-muted-foreground text-sm">{t("imports.sourceFlow.skippedHelp")}</p>
					) : (
						<>
							<p className="text-muted-foreground text-sm">{t("imports.sourceFlow.keysHelp")}</p>
							<ul className="grid gap-2">
								{type.keys.map((key) => (
									<KeyCard
										key={key.key}
										surveyKey={key}
										of={type.count}
										target={mapped.keys.find((each) => each.key === key.key)?.to ?? null}
										options={keyOptions(t, key.kind as SourceValueKind, mapped, fields, types, settings, postTypes)}
										onChange={(to) =>
											change({
												...mapped,
												keys: mapped.keys.some((each) => each.key === key.key)
													? mapped.keys.map((each) => (each.key === key.key ? { key: key.key, to } : each))
													: [...mapped.keys, { key: key.key, to }],
											})
										}
									/>
								))}
							</ul>
						</>
					)}
				</section>
			) : null}

			{type ? (
				<SampleEntry
					key={type.key}
					siteId={siteId}
					fileId={file.id}
					settings={settings}
					type={type}
					importId={importId}
				/>
			) : null}
		</div>
	);
}

/** Where a type's items go, in words. */
function destinationText(
	t: ReturnType<typeof useT>,
	own: TypeSettings | undefined,
	postTypes: readonly { id: string; name: string }[],
): string {
	const to = own?.to ?? null;
	if (to === null) return t("imports.sourceFlow.skipped");
	if (to === "media") return t("imports.sourceFlow.toMedia");
	if ("newPostType" in to) return t("imports.sourceFlow.toNew", { name: to.newPostType.name });
	return t("imports.sourceFlow.toPostType", { name: postTypes.find((each) => each.id === to.postTypeId)?.name ?? "—" });
}

function destinationValue(to: TypeSettings["to"]): string {
	if (to === null) return "skip";
	if (to === "media") return "media";
	if ("newPostType" in to) return "new";
	return `postType:${to.postTypeId}`;
}

/** A type going elsewhere: a Post Type's keys start where the same names go, a new one's from scratch. */
function withDestination(mapped: TypeSettings, value: string, type: SurveyType): TypeSettings {
	if (value === "skip") return { ...mapped, to: null };
	if (value === "media") return { ...mapped, to: "media" };
	const keys = mapped.keys.map((key) => ({
		key: key.key,
		to: key.to && typeof key.to === "string" && !key.to.startsWith("fields.") ? key.to : null,
	}));
	if (value === "new") return { ...mapped, to: { newPostType: { name: type.label } }, keys };
	return { ...mapped, to: { postTypeId: value.slice("postType:".length) }, keys };
}

type KeyOption = { value: string; label: string; to: KeyTarget };

/** Where a key can go, for its kind of value and its type's Post Type. */
function keyOptions(
	t: ReturnType<typeof useT>,
	kind: SourceValueKind,
	mapped: TypeSettings,
	fields: Map<string, PostTypeFields>,
	types: readonly SurveyType[],
	settings: SourceSettings,
	postTypes: readonly { id: string; name: string; builtIn: string | null }[],
): KeyOption[] {
	const options: KeyOption[] = [{ value: "skip", label: t("imports.map.skip"), to: null }];
	for (const place of [
		"title",
		"slug",
		"seo.title",
		"seo.description",
		"seo.canonical",
		"seo.noindex",
		"seo.image",
	] as const) {
		if (takes(place, kind)) options.push({ value: place, label: t(`imports.sourceFlow.places.${place}`), to: place });
	}
	const to = mapped.to;
	const postType = to && typeof to === "object" && "postTypeId" in to ? fields.get(to.postTypeId) : undefined;
	const isPages =
		to &&
		typeof to === "object" &&
		"postTypeId" in to &&
		postTypes.find((each) => each.id === to.postTypeId)?.builtIn === "page";
	for (const field of postType?.fields ?? []) {
		if (takes(field.type, kind)) {
			options.push({
				value: `fields.${field.key}`,
				label: t("imports.sourceFlow.field", {
					label: field.label,
					type: t(`content.types.${field.type}` as MessageKey),
				}),
				to: `fields.${field.key}`,
			});
		}
	}
	const taken = new Set([
		...(postType?.fields ?? []).map((field) => field.key),
		...mapped.keys.flatMap((key) => (key.to && typeof key.to === "object" ? [key.to.newField.key] : [])),
	]);
	const hasBody =
		(postType?.fields ?? []).some((field) => field.type === "body") ||
		mapped.keys.some((key) => key.to && typeof key.to === "object" && key.to.newField.type === "body");
	for (const type of NEW_FIELD_TYPES) {
		if (!takes(type, kind) || (type === "body" && (isPages || hasBody))) continue;
		if (type === "relationship") {
			for (const other of types) {
				const target = settings.types.find((each) => each.type === other.key)?.to;
				if (other.holds !== "entries" || !target || target === "media") continue;
				options.push(newFieldOption(t, other.label, type, taken, other.key));
			}
			continue;
		}
		options.push(newFieldOption(t, null, type, taken));
	}
	return options;
}

function newFieldOption(
	t: ReturnType<typeof useT>,
	label: string | null,
	type: NewFieldType,
	taken: ReadonlySet<string>,
	to?: string,
): KeyOption {
	const name = label ?? t(`content.types.${type}` as MessageKey);
	return {
		value: `new:${type}:${to ?? ""}`,
		label: t("imports.sourceFlow.newField", { label: name, type: t(`content.types.${type}` as MessageKey) }),
		to: { newField: { key: freeKey(name, taken), label: name, type, ...(to ? { to } : {}) } },
	};
}

function freeKey(label: string, taken: ReadonlySet<string>): string {
	const base =
		label
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "")
			.slice(0, 60) || "field";
	const start = /^[a-z]/.test(base) ? base : `field_${base}`;
	let key = start;
	for (let n = 2; taken.has(key); n++) key = `${start}_${n}`;
	return key;
}

function optionValue(target: KeyTarget): string {
	if (target === null) return "skip";
	if (typeof target === "string") return target;
	return `new:${target.newField.type}:${target.newField.to ?? ""}`;
}

/** One key: its name, how many items have it and a value, and where it goes. */
function KeyCard({
	surveyKey,
	of,
	target,
	options,
	onChange,
}: {
	surveyKey: SurveyType["keys"][number];
	of: number;
	target: KeyTarget;
	options: KeyOption[];
	onChange(to: KeyTarget): void;
}) {
	const t = useT();
	const id = useId();
	const value = optionValue(target);
	// A target the options don't offer as such (a new Field named by hand) is kept as an option.
	const known = options.some((option) => option.value === value);
	const label =
		target && typeof target === "object"
			? t("imports.sourceFlow.newField", {
					label: target.newField.label,
					type: t(`content.types.${target.newField.type}` as MessageKey),
				})
			: value;
	return (
		<li
			className={cn(
				"grid gap-3 rounded-lg border p-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(12rem,16rem)] sm:items-center",
				target === null && "opacity-75",
			)}
		>
			<div className="grid gap-1">
				<code className="bg-muted justify-self-start rounded px-1.5 py-0.5 text-sm">{surveyKey.key}</code>
				<span className="text-muted-foreground text-sm">
					{t("imports.sourceFlow.keyIn", { count: surveyKey.count, of })}
					{surveyKey.sample ? ` · “${surveyKey.sample}”` : ""}
				</span>
			</div>
			<ArrowRightIcon className="text-muted-foreground hidden size-4 sm:block rtl:rotate-180" aria-hidden="true" />
			<div className="grid gap-1">
				<label htmlFor={id} className="sr-only">
					{t("imports.sourceFlow.keyTarget", { key: surveyKey.key })}
				</label>
				<NativeSelect
					id={id}
					className="w-full"
					value={value}
					onChange={(event) => {
						const chosen = options.find((option) => option.value === event.target.value);
						onChange(chosen ? chosen.to : target);
					}}
				>
					{known ? null : <NativeSelectOption value={value}>{label}</NativeSelectOption>}
					{options.map((option) => (
						<NativeSelectOption key={option.value} value={option.value}>
							{option.label}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</div>
		</li>
	);
}

/** The live sample Entry: one of the type's first items, read with the mapping as it is now. */
function SampleEntry({
	siteId,
	fileId,
	settings,
	type,
	importId,
}: {
	siteId: string;
	fileId: string;
	settings: SourceSettings;
	type: SurveyType;
	importId: string | null;
}) {
	const t = useT();
	const ids = useId();
	const [index, setIndex] = useState(0);
	const [sample, setSample] = useState<SourceSampleView | null>(null);
	const [problem, setProblem] = useState<MessageKey | null>(null);
	const key = JSON.stringify([fileId, settings, type.key, index]);
	const latest = useRef(key);
	useEffect(() => {
		latest.current = key;
		const timer = setTimeout(async () => {
			try {
				const api = await getApi();
				const answer = await api.imports.sample({ siteId, fileId, settings, type: type.key, index, importId });
				if (latest.current === key) {
					setSample(answer.sample);
					setProblem(null);
				}
			} catch (failure) {
				if (latest.current === key) setProblem(sourceSettingWording(failure) ?? errorMessage(failure));
			}
		}, 250);
		return () => clearTimeout(timer);
	}, [key, siteId, fileId, settings, type.key, index, importId]);
	const of = sample?.of ?? type.samples;
	return (
		<aside aria-labelledby={`${ids}-sample`} className="grid content-start gap-3">
			<div className="flex items-center justify-between gap-2">
				<h2 id={`${ids}-sample`} className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
					{t("imports.sourceFlow.sample")}
				</h2>
				<div className="flex items-center gap-1">
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={t("imports.sourceFlow.previousSample")}
						disabled={index === 0}
						onClick={() => setIndex((at) => Math.max(0, at - 1))}
					>
						<ChevronLeftIcon className="rtl:rotate-180" aria-hidden="true" />
					</Button>
					<span className="text-muted-foreground text-sm tabular-nums" aria-live="polite">
						{t("imports.sourceFlow.sampleOf", { at: Math.min(index + 1, of), count: type.count })}
					</span>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={t("imports.sourceFlow.nextSample")}
						disabled={index + 1 >= of}
						onClick={() => setIndex((at) => at + 1)}
					>
						<ChevronRightIcon className="rtl:rotate-180" aria-hidden="true" />
					</Button>
				</div>
			</div>
			<div className="grid gap-3 rounded-lg border p-4" aria-live="polite">
				{problem ? (
					<p className="text-destructive text-sm">{t(problem)}</p>
				) : sample?.media ? (
					<dl className="grid gap-2 text-sm">
						<Pair term={t("imports.sourceFlow.fileName")} value={sample.media.address.split("/").pop() ?? ""} />
						<Pair term={t("imports.sourceFlow.alt")} value={sample.media.alt} />
						<Pair term={t("imports.sourceFlow.caption")} value={sample.media.caption} />
					</dl>
				) : sample?.entry ? (
					<EntrySummary entry={sample.entry} />
				) : sample ? (
					<p className="text-muted-foreground text-sm">{t("imports.sourceFlow.sampleSkipped")}</p>
				) : (
					<p className="text-muted-foreground flex items-center gap-2 text-sm">
						<LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
						{t("imports.sourceFlow.sampleLoading")}
					</p>
				)}
			</div>
			<Note icon={<RefreshCwIcon className="size-4" aria-hidden="true" />}>
				{t("imports.sourceFlow.sampleUpdates")}
			</Note>
		</aside>
	);
}

function Pair({ term, value, warn }: { term: string; value: string | null | undefined; warn?: boolean }) {
	return (
		<div className="grid gap-0.5">
			<dt className={cn("text-muted-foreground", warn && "text-amber-700 dark:text-amber-300")}>{term}</dt>
			<dd className="break-words">{value || "—"}</dd>
		</div>
	);
}

/** An Entry as a sample shows it: its title, Fields, SEO fields and its body's Blocks in short. */
function EntrySummary({ entry }: { entry: PreviewEntryView }) {
	const t = useT();
	return (
		<dl className="grid gap-2 text-sm">
			<Pair term={t("content.builtIn.title")} value={entry.title} />
			{entry.fields.map((field) => (
				<Pair key={field.key} term={field.label} value={field.value} />
			))}
			{Object.entries(entry.seo).map(([part, value]) => (
				<Pair key={part} term={t(`imports.sourceFlow.places.seo.${part}` as MessageKey)} value={String(value)} />
			))}
			{entry.skippedKeys
				.filter((key) => !key.startsWith("_"))
				.slice(0, 3)
				.map((key) => (
					<Pair key={key} term={t("imports.sourceFlow.notMapped", { key })} value="" warn />
				))}
			{entry.body ? (
				<Pair
					term={t("imports.sourceFlow.bodyBlocks", { label: entry.body.label, count: entry.body.blocks.length })}
					value={entry.body.blocks.map((block) => blockSummary(block)).find((text) => text !== "") ?? ""}
				/>
			) : null}
			{entry.leftovers.length > 0 ? (
				<Pair term={t("imports.sourceFlow.leftoverCount", { count: entry.leftovers.length })} value="" warn />
			) : null}
		</dl>
	);
}

// ---------------------------------------------------------------------------------------------------
// Preview

/** Preview: what the run would do, worked out in the worker, with the first Entries of each type. */
function PreviewStep({
	siteId,
	fileId,
	settings,
	importId,
	onError,
}: {
	siteId: string;
	fileId: string;
	settings: SourceSettings;
	importId: string | null;
	onError(key: MessageKey): void;
}) {
	const t = useT();
	const [preview, setPreview] = useState<SourcePreviewView | null>(null);
	const report = useRef(onError);
	report.current = onError;
	useEffect(() => {
		let stop = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const ask = async () => {
			try {
				const api = await getApi();
				const { preview: latest } = await api.imports.previewSource({ siteId, fileId, settings, importId });
				if (stop) return;
				setPreview(latest);
				if (latest.status === "working") timer = setTimeout(ask, POLL_MS);
			} catch (failure) {
				if (!stop) report.current(sourceSettingWording(failure) ?? errorMessage(failure));
			}
		};
		void ask();
		return () => {
			stop = true;
			clearTimeout(timer);
		};
	}, [siteId, fileId, settings, importId]);

	if (!preview || preview.status === "working") {
		const done = preview?.progress.done ?? 0;
		const total = preview?.progress.total ?? 0;
		return (
			<p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
				<LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
				{t("imports.sourceFlow.previewWorking", { done, total })}
			</p>
		);
	}
	if (preview.status === "failed") {
		return (
			<p className="text-destructive text-sm" role="alert">
				{t("imports.sourceFlow.previewFailed")}
			</p>
		);
	}
	const entryTypes = preview.types.filter((type) => type.to?.kind === "postType");
	return (
		<div className="grid gap-6">
			<ul
				className="bg-muted/40 flex flex-wrap gap-x-6 gap-y-2 rounded-lg border px-4 py-3 text-sm"
				aria-label={t("imports.sourceFlow.previewSummary")}
			>
				<li>{t("imports.sourceFlow.drafts", { count: preview.counts.create + preview.counts.update })}</li>
				{preview.newPostTypes.length > 0 ? (
					<li>
						{t("imports.sourceFlow.newPostTypes", {
							count: preview.newPostTypes.length,
							names: preview.newPostTypes.join(", "),
						})}
					</li>
				) : null}
				<li>{t("imports.sourceFlow.mediaFiles", { count: preview.files })}</li>
				<li>
					{preview.redirectsOn
						? t("imports.sourceFlow.redirectRules", { count: preview.redirects })
						: t("imports.sourceFlow.noRedirectRules")}
				</li>
				<li>{t("imports.sourceFlow.leftovers", { count: preview.leftovers })}</li>
				{preview.skippedTypes.length + preview.skippedKeys.length > 0 ? (
					<li>
						{t("imports.sourceFlow.skippedSummary", {
							types: preview.skippedTypes.length,
							keys: preview.skippedKeys.reduce((sum, each) => sum + each.keys.length, 0),
						})}
					</li>
				) : null}
			</ul>
			{entryTypes.length > 0 ? (
				<Tabs
					label={t("imports.sourceFlow.previewTypes")}
					tabs={entryTypes.map((type) => ({
						id: `preview-${type.type}`,
						label: type.label,
						panel: (
							<PreviewEntries
								entries={preview.entries.filter((entry) => entry.type === type.type)}
								count={type.count}
								label={type.label}
							/>
						),
					}))}
				/>
			) : null}
		</div>
	);
}

/** One type's first Entries, searchable, each opening on the side with its Fields, Blocks and rule. */
function PreviewEntries({
	entries,
	count,
	label,
}: {
	entries: readonly PreviewEntryView[];
	count: number;
	label: string;
}) {
	const t = useT();
	const ids = useId();
	const [query, setQuery] = useState("");
	const shown = entries.filter((entry) => entry.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
	const [chosen, setChosen] = useState(entries[0]?.sourceId ?? "");
	const entry = entries.find((each) => each.sourceId === chosen) ?? shown[0];
	return (
		<div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
			<div className="grid content-start gap-3">
				<Field>
					<FieldLabel htmlFor={`${ids}-search`} className="sr-only">
						{t("imports.sourceFlow.search", { label })}
					</FieldLabel>
					<Input
						id={`${ids}-search`}
						type="search"
						placeholder={t("imports.sourceFlow.search", { label })}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</Field>
				<ul className="grid gap-1">
					{shown.map((each) => (
						<li key={each.sourceId}>
							<button
								type="button"
								aria-current={entry?.sourceId === each.sourceId ? "true" : undefined}
								onClick={() => setChosen(each.sourceId)}
								className={cn(
									"hover:bg-muted/60 focus-visible:ring-ring/50 grid w-full gap-0.5 rounded-lg p-3 text-start outline-none focus-visible:ring-3",
									entry?.sourceId === each.sourceId && "bg-muted",
								)}
							>
								<span className="flex items-center justify-between gap-2 font-medium">
									{each.title || t("content.relationship.untitled")}
									{each.leftovers.length > 0 ? (
										<Badge variant="outline" className="border-amber-300 text-amber-800 dark:text-amber-200">
											{t("imports.sourceFlow.leftoverBadge", { count: each.leftovers.length })}
										</Badge>
									) : null}
								</span>
								<span className="text-muted-foreground font-mono text-xs">{each.path ?? "—"}</span>
							</button>
						</li>
					))}
				</ul>
				{count > entries.length ? (
					<p className="text-muted-foreground text-sm">
						{t("imports.sourceFlow.firstOf", { shown: entries.length, count })}
					</p>
				) : null}
			</div>
			{entry ? <PreviewEntryDetail entry={entry} /> : null}
		</div>
	);
}

function PreviewEntryDetail({ entry }: { entry: PreviewEntryView }) {
	const t = useT();
	const ids = useId();
	const action: MessageKey =
		entry.action === "create"
			? "imports.sourceFlow.willCreate"
			: entry.action === "update"
				? "imports.sourceFlow.willUpdate"
				: entry.action === "skip"
					? "imports.sourceFlow.willSkip"
					: "imports.sourceFlow.willNot";
	const leftovers = new Map(
		entry.leftovers.flatMap((leftover) => (leftover.blockId ? [[leftover.blockId, leftover]] : [])),
	);
	return (
		<section aria-labelledby={`${ids}-entry`} className="grid content-start gap-4">
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<h2 id={`${ids}-entry`} className="text-xl font-semibold">
					{entry.title || t("content.relationship.untitled")}{" "}
					<span className="text-muted-foreground text-sm font-normal">{t(action)}</span>
				</h2>
				<p className="text-muted-foreground text-sm">
					{t("imports.sourceFlow.sourceId")} <code>{entry.sourceId}</code>
				</p>
			</div>
			<div className="grid gap-4 xl:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
				<div className="grid content-start gap-4 rounded-lg border p-4">
					<h3 className="font-medium">{t("imports.sourceFlow.fields")}</h3>
					<EntrySummary entry={{ ...entry, body: null, leftovers: [], skippedKeys: [] }} />
					{entry.redirect ? (
						<div className="grid gap-1 border-t pt-3 text-sm">
							<h3 className="text-muted-foreground">{t("imports.sourceFlow.redirectRule")}</h3>
							<code className="bg-muted justify-self-start rounded px-1.5 py-0.5 text-xs">{entry.redirect.from}</code>
							<code className="bg-muted justify-self-start rounded px-1.5 py-0.5 text-xs">→ {entry.redirect.to}</code>
						</div>
					) : null}
					{entry.problems.length > 0 ? (
						<ul className="text-destructive grid gap-1 border-t pt-3 text-sm">
							{entry.problems.map((problem, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: an Entry can have the same problem at two keys.
								<li key={index}>
									<code>{problem.column ?? "—"}</code>: {problem.rule}
								</li>
							))}
						</ul>
					) : null}
				</div>
				<div className="grid content-start gap-3 rounded-lg border p-4">
					<h3 className="font-medium">
						{entry.body
							? t("imports.sourceFlow.bodyBlocks", { label: entry.body.label, count: entry.body.blocks.length })
							: t("imports.sourceFlow.noBody")}
					</h3>
					{entry.body ? (
						<ol className="grid gap-2">
							{entry.body.blocks.map((block) => {
								const leftover = leftovers.get(block.id);
								return (
									<li
										key={block.id}
										className={cn(
											"grid grid-cols-[7rem_minmax(0,1fr)] gap-3 rounded-md p-2 text-sm",
											leftover && "bg-amber-50 text-amber-950 dark:bg-amber-950 dark:text-amber-100",
										)}
									>
										<code className="text-muted-foreground text-xs">{block.type}</code>
										<span className="break-words">
											{blockSummary(block, entry.images)}
											{leftover ? <span className="sr-only"> ({t("imports.sourceFlow.leftover")})</span> : null}
										</span>
									</li>
								);
							})}
						</ol>
					) : null}
					{entry.leftovers.length > 0 ? <Warning>{t("imports.sourceFlow.leftoverNote")}</Warning> : null}
				</div>
			</div>
		</section>
	);
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
