import { createFileRoute, useRouter } from "@tanstack/react-router";
import type { Library } from "@webcraft/core";
import { Button } from "@webcraft/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import {
	Field,
	FieldContent,
	FieldDescription,
	FieldGroup,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { RadioGroup, RadioGroupItem } from "@webcraft/ui/components/radio-group.tsx";
import { ArrowUpCircleIcon, DownloadIcon, EllipsisIcon, PlusIcon, RefreshCwIcon, TrashIcon } from "lucide-react";
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../../ui/api.ts";
import { errorCode, errorMessage } from "../../ui/errors.ts";
import { formatUtc } from "../../ui/format.ts";
import { type MessageKey, pageTitle, useT } from "../../ui/i18n.tsx";
import { formatBytes } from "../../ui/media/preview.ts";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";
import { ConfirmDialog } from "../../ui/settings/confirm.tsx";
import { SettingsCard, SettingsListRow, SettingsRows, StateBadge } from "../../ui/settings/layout.tsx";
import { PageSheet } from "../../ui/shell/page.tsx";

export const Route = createFileRoute("/_admin/sites/$siteId/libraries")({
	staticData: { crumb: "libraries.pageTitle", width: "form" },
	loader: async ({ context, params }) => {
		if (!context.place.permissions.includes("structure.edit")) return null;
		const api = await getApi();
		return api.libraries.list({ siteId: params.siteId });
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "libraries.pageTitle") }],
	}),
	component: LibrariesPage,
});

/** Why a Library was refused, in the admin's words. */
function refusalText(failure: unknown): MessageKey {
	if (errorCode(failure) !== "LIBRARY_REFUSED") return errorMessage(failure);
	const problem = (failure as { data?: { problem?: string } }).data?.problem;
	switch (problem) {
		case "name":
		case "version":
		case "file":
		case "url":
		case "notFound":
		case "fileNotFound":
		case "integrity":
		case "size":
		case "empty":
		case "unreachable":
		case "limit":
			return `libraries.problems.${problem}`;
		default:
			return "errors.generic";
	}
}

/**
 * Site › Libraries (Structure, Staff only; ADR 0023): the script packages this Site loads on every
 * page, before the Site script, each kept at a fixed version and served from the Site's own domain.
 * Staff add one by package and version (from the npm registry) or by address, in a sheet; WebCraft
 * downloads it once and checks it. Checking for updates says which have newer versions; nothing
 * updates until Staff update it. Drawn as a settings list (as Site › Outside scripts): a row per
 * Library with its state and its menu.
 */
function LibrariesPage() {
	const t = useT();
	const data = Route.useLoaderData();
	const { siteId } = Route.useParams();
	const router = useRouter();
	const addButton = useRef<HTMLButtonElement>(null);
	const [adding, setAdding] = useState(false);
	const [checking, setChecking] = useState(false);
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	const { libraries } = data;
	const checked = libraries.flatMap((library) => (library.checkedAt ? [new Date(library.checkedAt).getTime()] : []));
	const lastChecked = checked.length > 0 ? new Date(Math.min(...checked)) : null;
	const fromRegistry = libraries.some((library) => library.source === "npm");

	const check = async () => {
		setChecking(true);
		try {
			const api = await getApi();
			const { libraries: found } = await api.libraries.checkUpdates({ siteId });
			const newer = found.filter((library) => library.newerVersion).length;
			toast.success(newer === 0 ? t("libraries.upToDate") : t("libraries.updatesFound", { count: newer }));
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setChecking(false);
		}
	};

	return (
		<>
			<PageHeader heading={t("libraries.heading")}>{t("libraries.intro")}</PageHeader>
			<div className="grid gap-6">
				<SettingsCard
					title={t("libraries.listTitle")}
					description={
						lastChecked ? (
							<>
								{t("libraries.listIntro")} {t("libraries.checkedAt", { time: formatUtc(lastChecked) })}
							</>
						) : (
							t("libraries.listIntro")
						)
					}
					action={
						<>
							{fromRegistry ? (
								<Button variant="outline" onClick={check} disabled={checking}>
									<RefreshCwIcon aria-hidden="true" />
									{checking ? t("libraries.checking") : t("libraries.check")}
								</Button>
							) : null}
							<Button ref={addButton} variant="outline" onClick={() => setAdding(true)}>
								<PlusIcon aria-hidden="true" />
								{t("libraries.addButton")}
							</Button>
						</>
					}
				>
					{libraries.length === 0 ? (
						<p className="text-muted-foreground text-sm">{t("libraries.none")}</p>
					) : (
						<SettingsRows>
							{libraries.map((library) => (
								<SettingsListRow
									key={library.id}
									badge={<LibraryState library={library} />}
									detail={
										<div className="space-y-0.5">
											<p className="truncate font-mono" title={library.file ?? library.url ?? undefined}>
												{library.file ?? library.url}
											</p>
											<p>
												{[
													`${t("libraries.version")}: ${library.version ?? t("libraries.byAddress")}`,
													`${t("libraries.size")}: ${formatBytes(library.size)}`,
													`${t("libraries.licence")}: ${library.licence ?? "—"}`,
												].join(" · ")}
											</p>
										</div>
									}
									actions={<LibraryActions siteId={siteId} library={library} />}
								>
									<span className="min-w-0 break-all">{library.name}</span>
								</SettingsListRow>
							))}
						</SettingsRows>
					)}
				</SettingsCard>
				<p className="text-muted-foreground text-sm">{t("libraries.appliesAtOnce")}</p>
			</div>
			{adding ? <AddLibrarySheet siteId={siteId} onClose={() => setAdding(false)} finalFocus={addButton} /> : null}
		</>
	);
}

/**
 * A Library's state in words: a newer version waiting, on its newest version (once checked), or a
 * fixed copy of an address.
 */
function LibraryState({ library }: { library: Library }) {
	const t = useT();
	if (library.newerVersion) {
		return <StateBadge tone="warning">{t("libraries.newer", { version: library.newerVersion })}</StateBadge>;
	}
	if (library.source === "url") return <StateBadge>{t("libraries.byAddress")}</StateBadge>;
	if (library.checkedAt) return <StateBadge tone="success">{t("libraries.newest")}</StateBadge>;
	return null;
}

/** Adding a Library, in a sheet: a package of the npm registry at a version (and a file of it), or an https address. */
function AddLibrarySheet({
	siteId,
	onClose,
	finalFocus,
}: {
	siteId: string;
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const [source, setSource] = useState<"npm" | "url">("npm");
	const [packageName, setPackageName] = useState("");
	const [version, setVersion] = useState("");
	const [file, setFile] = useState("");
	const [url, setUrl] = useState("");
	const [busy, setBusy] = useState(false);
	const ready = source === "npm" ? packageName.trim() !== "" && version.trim() !== "" : url.trim() !== "";
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!ready) return;
		setBusy(true);
		try {
			const api = await getApi();
			const { library } = await api.libraries.add({
				siteId,
				library:
					source === "npm" ? { source, packageName, version, ...(file.trim() ? { file } : {}) } : { source, url },
			});
			toast.success(t("libraries.added", { name: library.name, version: library.version ?? "" }));
			onClose();
			await router.invalidate();
		} catch (failure) {
			toast.error(t(refusalText(failure)));
		} finally {
			setBusy(false);
		}
	};
	return (
		<PageSheet
			open
			onOpenChange={(open) => !open && onClose()}
			title={t("libraries.addTitle")}
			description={t("libraries.addIntro")}
			finalFocus={finalFocus}
			className="data-[side=right]:sm:max-w-lg"
			footer={
				<>
					<Button type="button" variant="outline" onClick={onClose}>
						{t("libraries.cancel")}
					</Button>
					<Button type="submit" form={`${id}-form`} disabled={busy || !ready}>
						<DownloadIcon aria-hidden="true" />
						{busy ? t("libraries.adding") : t("libraries.add")}
					</Button>
				</>
			}
		>
			<form id={`${id}-form`} onSubmit={submit} noValidate>
				<FieldGroup className="gap-6">
					<FieldSet>
						<FieldLegend variant="label">{t("libraries.source")}</FieldLegend>
						<RadioGroup value={source} onValueChange={(value) => setSource(value as "npm" | "url")}>
							<Field orientation="horizontal">
								<RadioGroupItem value="npm" id={`${id}-npm`} aria-describedby={`${id}-npm-help`} />
								<FieldContent>
									<FieldLabel htmlFor={`${id}-npm`}>{t("libraries.fromRegistry")}</FieldLabel>
									<FieldDescription id={`${id}-npm-help`}>{t("libraries.fromRegistryHelp")}</FieldDescription>
								</FieldContent>
							</Field>
							<Field orientation="horizontal">
								<RadioGroupItem value="url" id={`${id}-url`} aria-describedby={`${id}-url-help`} />
								<FieldContent>
									<FieldLabel htmlFor={`${id}-url`}>{t("libraries.fromAddress")}</FieldLabel>
									<FieldDescription id={`${id}-url-help`}>{t("libraries.fromAddressHelp")}</FieldDescription>
								</FieldContent>
							</Field>
						</RadioGroup>
					</FieldSet>
					{source === "npm" ? (
						<>
							<Field>
								<FieldLabel htmlFor={`${id}-package`}>{t("libraries.package")}</FieldLabel>
								<Input
									id={`${id}-package`}
									value={packageName}
									required
									maxLength={214}
									autoComplete="off"
									spellCheck={false}
									onChange={(event) => setPackageName(event.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor={`${id}-version`}>{t("libraries.version")}</FieldLabel>
								<Input
									id={`${id}-version`}
									value={version}
									required
									maxLength={100}
									autoComplete="off"
									spellCheck={false}
									onChange={(event) => setVersion(event.target.value)}
									aria-describedby={`${id}-version-help`}
								/>
								<FieldDescription id={`${id}-version-help`}>{t("libraries.versionHelp")}</FieldDescription>
							</Field>
							<Field>
								<FieldLabel htmlFor={`${id}-file`}>{t("libraries.fileOptional")}</FieldLabel>
								<Input
									id={`${id}-file`}
									value={file}
									maxLength={300}
									autoComplete="off"
									spellCheck={false}
									className="font-mono"
									onChange={(event) => setFile(event.target.value)}
									aria-describedby={`${id}-file-help`}
								/>
								<FieldDescription id={`${id}-file-help`}>{t("libraries.fileHelp")}</FieldDescription>
							</Field>
						</>
					) : (
						<Field>
							<FieldLabel htmlFor={`${id}-address`}>{t("libraries.address")}</FieldLabel>
							<Input
								id={`${id}-address`}
								type="url"
								value={url}
								required
								maxLength={2000}
								autoComplete="off"
								spellCheck={false}
								className="font-mono"
								onChange={(event) => setUrl(event.target.value)}
								aria-describedby={`${id}-address-help`}
							/>
							<FieldDescription id={`${id}-address-help`}>{t("libraries.addressHelp")}</FieldDescription>
						</Field>
					)}
				</FieldGroup>
			</form>
		</PageSheet>
	);
}

/** A Library's actions: update it (to its newer version, or download it again from its address), remove it. */
function LibraryActions({ siteId, library }: { siteId: string; library: Library }) {
	const t = useT();
	const router = useRouter();
	const trigger = useRef<HTMLButtonElement>(null);
	const [removing, setRemoving] = useState(false);
	const update = async () => {
		const pending = toast.loading(t("libraries.updating", { name: library.name }));
		try {
			const api = await getApi();
			const { library: updated } = await api.libraries.update({
				siteId,
				libraryId: library.id,
				...(library.newerVersion ? { version: library.newerVersion } : {}),
			});
			toast.success(t("libraries.updated", { name: updated.name, version: updated.version ?? "" }), { id: pending });
			await router.invalidate();
		} catch (failure) {
			toast.error(t(refusalText(failure)), { id: pending });
		}
	};
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					ref={trigger}
					render={
						<Button variant="ghost" size="icon-sm" aria-label={t("libraries.actionsOf", { name: library.name })} />
					}
				>
					<EllipsisIcon aria-hidden="true" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-auto min-w-56">
					{library.newerVersion ? (
						<DropdownMenuItem onClick={update}>
							<ArrowUpCircleIcon aria-hidden="true" />
							{t("libraries.updateTo", { version: library.newerVersion })}
						</DropdownMenuItem>
					) : null}
					{library.source === "url" ? (
						<DropdownMenuItem onClick={update}>
							<DownloadIcon aria-hidden="true" />
							{t("libraries.downloadAgain")}
						</DropdownMenuItem>
					) : null}
					<DropdownMenuItem variant="destructive" onClick={() => setRemoving(true)}>
						<TrashIcon aria-hidden="true" />
						{t("libraries.remove")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{removing ? (
				<RemoveLibraryDialog
					siteId={siteId}
					library={library}
					onClose={() => setRemoving(false)}
					finalFocus={trigger}
				/>
			) : null}
		</>
	);
}

function RemoveLibraryDialog({
	siteId,
	library,
	onClose,
	finalFocus,
}: {
	siteId: string;
	library: Library;
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const router = useRouter();
	return (
		<ConfirmDialog
			open
			onOpenChange={(open) => !open && onClose()}
			title={t("libraries.removeTitle", { name: library.name })}
			confirm={t("libraries.remove")}
			finalFocus={finalFocus}
			onConfirm={async () => {
				try {
					const api = await getApi();
					await api.libraries.remove({ siteId, libraryId: library.id });
					toast.success(t("libraries.removed", { name: library.name }));
					await router.invalidate();
				} catch (failure) {
					toast.error(t(errorMessage(failure)));
				}
			}}
		>
			{t("libraries.removeText")}
		</ConfirmDialog>
	);
}
