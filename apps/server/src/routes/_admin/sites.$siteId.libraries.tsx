import { createFileRoute, useRouter } from "@tanstack/react-router";
import type { Library } from "@webcraft/core";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@webcraft/ui/components/card.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { ArrowUpCircleIcon, DownloadIcon, EllipsisIcon, RefreshCwIcon, TrashIcon } from "lucide-react";
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../../ui/api.ts";
import { errorCode, errorMessage } from "../../ui/errors.ts";
import { formatUtc } from "../../ui/format.ts";
import { type MessageKey, pageTitle, useT } from "../../ui/i18n.tsx";
import { formatBytes } from "../../ui/media/preview.ts";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";

export const Route = createFileRoute("/_admin/sites/$siteId/libraries")({
	staticData: { crumb: "libraries.pageTitle" },
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
 * Staff add one by package and version (from the npm registry) or by address; WebCraft downloads it
 * once and checks it. Checking for updates says which have newer versions; nothing updates until
 * Staff update it.
 */
function LibrariesPage() {
	const t = useT();
	const data = Route.useLoaderData();
	const { siteId } = Route.useParams();
	const router = useRouter();
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
			<div className="grid max-w-4xl gap-8">
				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("libraries.listTitle")}</h2>
						</CardTitle>
						<CardDescription>
							{lastChecked ? t("libraries.checkedAt", { time: formatUtc(lastChecked) }) : t("libraries.listIntro")}
						</CardDescription>
						{fromRegistry ? (
							<CardAction>
								<Button variant="outline" size="sm" onClick={check} disabled={checking}>
									<RefreshCwIcon aria-hidden="true" />
									{checking ? t("libraries.checking") : t("libraries.check")}
								</Button>
							</CardAction>
						) : null}
					</CardHeader>
					<CardContent>
						{libraries.length === 0 ? (
							<p className="text-muted-foreground text-sm">{t("libraries.none")}</p>
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>{t("libraries.library")}</TableHead>
										<TableHead>{t("libraries.version")}</TableHead>
										<TableHead>{t("libraries.size")}</TableHead>
										<TableHead>{t("libraries.licence")}</TableHead>
										<TableHead>
											<span className="sr-only">{t("libraries.actions")}</span>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{libraries.map((library) => (
										<TableRow key={library.id}>
											<TableCell className="max-w-72">
												<div className="font-medium">{library.name}</div>
												<div className="text-muted-foreground truncate font-mono text-xs">
													{library.file ?? library.url}
												</div>
											</TableCell>
											<TableCell>
												<div className="flex flex-wrap items-center gap-2">
													<span>{library.version ?? t("libraries.byAddress")}</span>
													{library.newerVersion ? (
														<Badge variant="secondary">{t("libraries.newer", { version: library.newerVersion })}</Badge>
													) : null}
												</div>
											</TableCell>
											<TableCell className="whitespace-nowrap">{formatBytes(library.size)}</TableCell>
											<TableCell>{library.licence ?? "—"}</TableCell>
											<TableCell className="text-end">
												<LibraryActions siteId={siteId} library={library} />
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						)}
					</CardContent>
				</Card>
				<AddLibrary siteId={siteId} />
				<p className="text-muted-foreground text-sm">{t("libraries.appliesAtOnce")}</p>
			</div>
		</>
	);
}

/** Adding a Library: a package of the npm registry at a version (and a file of it), or an https address. */
function AddLibrary({ siteId }: { siteId: string }) {
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
		setBusy(true);
		try {
			const api = await getApi();
			const { library } = await api.libraries.add({
				siteId,
				library:
					source === "npm" ? { source, packageName, version, ...(file.trim() ? { file } : {}) } : { source, url },
			});
			toast.success(t("libraries.added", { name: library.name, version: library.version ?? "" }));
			setPackageName("");
			setVersion("");
			setFile("");
			setUrl("");
			await router.invalidate();
		} catch (failure) {
			toast.error(t(refusalText(failure)));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t("libraries.addTitle")}</h2>
				</CardTitle>
				<CardDescription>{t("libraries.addIntro")}</CardDescription>
			</CardHeader>
			<CardContent>
				<form onSubmit={submit} noValidate className="grid gap-6">
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
						<FieldGroup className="grid gap-6 sm:grid-cols-2">
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
							<Field className="sm:col-span-2">
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
						</FieldGroup>
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
					<div>
						<Button type="submit" disabled={busy || !ready}>
							<DownloadIcon aria-hidden="true" />
							{busy ? t("libraries.adding") : t("libraries.add")}
						</Button>
					</div>
				</form>
			</CardContent>
		</Card>
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
	const [busy, setBusy] = useState(false);
	const remove = async () => {
		setBusy(true);
		try {
			const api = await getApi();
			await api.libraries.remove({ siteId, libraryId: library.id });
			toast.success(t("libraries.removed", { name: library.name }));
			onClose();
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("libraries.close")} finalFocus={finalFocus}>
				<DialogHeader>
					<DialogTitle>{t("libraries.removeTitle", { name: library.name })}</DialogTitle>
					<DialogDescription>{t("libraries.removeText")}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>{t("libraries.cancel")}</DialogClose>
					<Button variant="destructive" onClick={remove} disabled={busy}>
						{t("libraries.remove")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
