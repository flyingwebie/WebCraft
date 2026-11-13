import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardDescription, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@webcraft/ui/components/dialog.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@webcraft/ui/components/empty.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { AppWindowIcon, ArchiveRestoreIcon, GlobeIcon, PlusIcon } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../../ui/api.ts";
import { errorCode, errorMessage } from "../../ui/errors.ts";
import { type MessageKey, pageTitle, useT } from "../../ui/i18n.tsx";
import { formatBytes } from "../../ui/media/preview.ts";
import { type MediaStorageView, QuotaNotice, StorageMeter } from "../../ui/media/StorageCard.tsx";
import { PageHeader } from "../../ui/PageHeader.tsx";
import type { AdminPlace } from "../../ui/shell/levels.ts";
import { slugFrom } from "../../ui/site-slug.ts";

export const Route = createFileRoute("/_admin/workspaces/$workspaceId/")({
	staticData: { crumb: "sites.pageTitle" },
	loader: async ({ params }) => {
		const api = await getApi();
		return { storage: await api.workspaces.storage({ workspaceId: params.workspaceId }) };
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "sites.pageTitle") }] }),
	component: SitesPage,
});

type WorkspacePlace = Extract<AdminPlace, { level: "workspace" }>;

/** Workspace › Sites: the Workspace's websites the person reaches; Staff create them here. */
function SitesPage() {
	const t = useT();
	const place = Route.useRouteContext().place as WorkspacePlace;
	const canCreate = place.permissions.includes("site.create");
	const canImport = place.permissions.includes("site.import");
	const { storage } = Route.useLoaderData();
	const actions =
		canCreate || canImport ? (
			<div className="flex flex-wrap gap-2">
				{canImport ? (
					<Button
						variant="outline"
						render={<Link to="/workspaces/$workspaceId/site-imports" params={{ workspaceId: place.workspace.id }} />}
						nativeButton={false}
					>
						<ArchiveRestoreIcon aria-hidden="true" />
						{t("siteImports.uploadTitle")}
					</Button>
				) : null}
				{canCreate ? <NewSiteDialog place={place} /> : null}
			</div>
		) : undefined;

	return (
		<>
			<PageHeader heading={t("sites.heading")} action={actions}>
				{t("sites.intro")}
			</PageHeader>
			{place.sites.length === 0 ? (
				<Empty className="border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<GlobeIcon aria-hidden="true" />
						</EmptyMedia>
						<EmptyTitle>
							<h2>{t("sites.empty.heading")}</h2>
						</EmptyTitle>
						<EmptyDescription>{canCreate ? t("sites.empty.bodyStaff") : t("sites.empty.body")}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{place.sites.map((site) => (
						<li key={site.id}>
							<Card className="relative h-full overflow-hidden pt-0">
								<div className="bg-muted text-muted-foreground flex h-24 items-center justify-center">
									<AppWindowIcon className="size-8" aria-hidden="true" />
								</div>
								<CardHeader>
									<CardTitle>
										<h2>
											<Link
												to="/sites/$siteId"
												params={{ siteId: site.id }}
												className="after:absolute after:inset-0 hover:underline"
											>
												{site.name}
											</Link>
										</h2>
									</CardTitle>
									<CardDescription>
										<span className="sr-only">{t("sites.slugLabel")}: </span>
										{site.slug}
									</CardDescription>
								</CardHeader>
							</Card>
						</li>
					))}
				</ul>
			)}
			<WorkspaceStorage
				workspaceId={place.workspace.id}
				storage={storage}
				canSetQuota={place.permissions.includes("quota.manage")}
			/>
		</>
	);
}

/**
 * The Workspace's Media storage: what its Sites' Media takes, its quota and the 80% notice; Staff set
 * or remove the quota.
 */
function WorkspaceStorage({
	workspaceId,
	storage,
	canSetQuota,
}: {
	workspaceId: string;
	storage: MediaStorageView;
	canSetQuota: boolean;
}) {
	const t = useT();
	return (
		<section aria-labelledby="workspace-storage-heading" className="mt-10 grid max-w-xl gap-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="grid gap-1">
					<h2 id="workspace-storage-heading" className="text-lg font-semibold tracking-tight">
						{t("workspaceStorage.heading")}
					</h2>
					<p className="text-muted-foreground text-sm">{t("workspaceStorage.intro")}</p>
				</div>
				{canSetQuota ? <QuotaDialog workspaceId={workspaceId} storage={storage} /> : null}
			</div>
			<QuotaNotice storage={storage} />
			<StorageMeter storage={storage} />
			<p className="text-muted-foreground text-sm">
				{storage.quotaBytes === null
					? t("workspaceStorage.noQuota")
					: t("workspaceStorage.quota", { quota: formatBytes(storage.quotaBytes) })}
			</p>
		</section>
	);
}

const GB = 1024 * 1024 * 1024;

/** Sets the Workspace's quota in GB (decimals allowed, at least 1 MB), or removes it when left empty. */
function QuotaDialog({ workspaceId, storage }: { workspaceId: string; storage: MediaStorageView }) {
	const t = useT();
	const router = useRouter();
	const trigger = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [gigabytes, setGigabytes] = useState(storage.quotaBytes === null ? "" : String(storage.quotaBytes / GB));
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const save = async (event: FormEvent) => {
		event.preventDefault();
		const text = gigabytes.trim().replace(",", ".");
		const value = Number(text);
		const quotaBytes = text === "" ? null : Math.round(value * GB);
		if (quotaBytes !== null && (!Number.isFinite(value) || quotaBytes < 1024 * 1024)) {
			setError("workspaceStorage.invalid");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await (await getApi()).workspaces.setQuota({ workspaceId, quotaBytes });
			toast.success(t(quotaBytes === null ? "workspaceStorage.removed" : "workspaceStorage.saved"));
			setOpen(false);
			await router.invalidate();
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<Button ref={trigger} variant="outline" onClick={() => setOpen(true)}>
				{storage.quotaBytes === null ? t("workspaceStorage.set") : t("workspaceStorage.change")}
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent closeLabel={t("workspaceStorage.close")} finalFocus={trigger}>
					<form onSubmit={save} className="grid gap-6" noValidate>
						<DialogHeader>
							<DialogTitle>{t("workspaceStorage.dialogTitle")}</DialogTitle>
							<DialogDescription>{t("workspaceStorage.dialogBody")}</DialogDescription>
						</DialogHeader>
						<Field data-invalid={error ? true : undefined}>
							<FieldLabel htmlFor="workspace-quota">{t("workspaceStorage.quotaLabel")}</FieldLabel>
							<Input
								id="workspace-quota"
								inputMode="decimal"
								value={gigabytes}
								onChange={(event) => setGigabytes(event.target.value)}
								autoComplete="off"
								aria-invalid={error ? true : undefined}
								aria-describedby={["workspace-quota-help", error ? "workspace-quota-error" : null]
									.filter(Boolean)
									.join(" ")}
							/>
							<FieldDescription id="workspace-quota-help">{t("workspaceStorage.quotaHelp")}</FieldDescription>
							{error ? <FieldError id="workspace-quota-error">{t(error)}</FieldError> : null}
						</Field>
						<DialogFooter>
							<DialogClose render={<Button variant="outline" type="button" />}>
								{t("workspaceStorage.cancel")}
							</DialogClose>
							<Button type="submit" disabled={busy}>
								{t("workspaceStorage.save")}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}

/** "New Site": a name and a slug (made from the name until the person changes it). */
function NewSiteDialog({ place }: { place: WorkspacePlace }) {
	const t = useT();
	const router = useRouter();
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [slugEdited, setSlugEdited] = useState(false);
	const [errors, setErrors] = useState<{ name?: MessageKey; slug?: MessageKey; form?: MessageKey }>({});
	const [busy, setBusy] = useState(false);

	const reset = () => {
		setName("");
		setSlug("");
		setSlugEdited(false);
		setErrors({});
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!name.trim()) {
			setErrors({ name: "sites.dialog.nameRequired" });
			return;
		}
		setBusy(true);
		setErrors({});
		try {
			const api = await getApi();
			const { site } = await api.sites.create({ workspaceId: place.workspace.id, name, slug });
			toast.success(t("sites.created", { name: site.name }));
			setOpen(false);
			reset();
			await router.invalidate();
			await navigate({ to: "/sites/$siteId", params: { siteId: site.id } });
		} catch (failure) {
			const code = errorCode(failure);
			const message = errorMessage(failure);
			setErrors(code === "SLUG_TAKEN" || code === "SLUG_INVALID" ? { slug: message } : { form: message });
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) reset();
			}}
		>
			<DialogTrigger render={<Button />}>
				<PlusIcon aria-hidden="true" />
				{t("sites.new")}
			</DialogTrigger>
			<DialogContent closeLabel={t("sites.dialog.close")} className="sm:max-w-md">
				<form onSubmit={submit} noValidate className="grid gap-4">
					<DialogHeader>
						<DialogTitle>{t("sites.dialog.title")}</DialogTitle>
						<DialogDescription>{t("sites.dialog.description", { workspace: place.workspace.name })}</DialogDescription>
					</DialogHeader>
					<FieldGroup>
						<Field data-invalid={errors.name ? true : undefined}>
							<FieldLabel htmlFor="site-name">{t("sites.dialog.name")}</FieldLabel>
							<Input
								id="site-name"
								value={name}
								maxLength={100}
								onChange={(event) => {
									setName(event.target.value);
									if (!slugEdited) setSlug(slugFrom(event.target.value));
								}}
								aria-invalid={errors.name ? true : undefined}
								aria-describedby={errors.name ? "site-name-error" : undefined}
							/>
							{errors.name ? <FieldError id="site-name-error">{t(errors.name)}</FieldError> : null}
						</Field>
						<Field data-invalid={errors.slug ? true : undefined}>
							<FieldLabel htmlFor="site-slug">{t("sites.dialog.slug")}</FieldLabel>
							<Input
								id="site-slug"
								value={slug}
								maxLength={63}
								spellCheck={false}
								autoCapitalize="none"
								onChange={(event) => {
									setSlug(event.target.value);
									setSlugEdited(true);
								}}
								aria-invalid={errors.slug ? true : undefined}
								aria-describedby={errors.slug ? "site-slug-help site-slug-error" : "site-slug-help"}
							/>
							<FieldDescription id="site-slug-help">{t("sites.dialog.slugHelp")}</FieldDescription>
							{errors.slug ? <FieldError id="site-slug-error">{t(errors.slug)}</FieldError> : null}
						</Field>
						{errors.form ? <FieldError>{t(errors.form)}</FieldError> : null}
					</FieldGroup>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("sites.dialog.cancel")}</DialogClose>
						<Button type="submit" disabled={busy}>
							{t("sites.dialog.create")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
