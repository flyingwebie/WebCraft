import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
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
import { ArchiveRestoreIcon, GlobeIcon, PlusIcon } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../../ui/api.ts";
import { ActivityCard, DomainState } from "../../ui/content/SiteOverview.tsx";
import { errorCode, errorMessage } from "../../ui/errors.ts";
import { type MessageKey, pageTitle, useT } from "../../ui/i18n.tsx";
import { formatBytes } from "../../ui/media/preview.ts";
import { type MediaStorageView, QuotaNotice, StorageMeter } from "../../ui/media/StorageCard.tsx";
import { PageHeader } from "../../ui/PageHeader.tsx";
import { SettingsCard, StateBadge } from "../../ui/settings/layout.tsx";
import type { AdminPlace } from "../../ui/shell/levels.ts";
import { slugFrom } from "../../ui/site-slug.ts";

/** How many of the Workspace's newest Audit log entries "Recent activity" shows. */
const ACTIVITY = 5;

export const Route = createFileRoute("/_admin/workspaces/$workspaceId/")({
	staticData: { crumb: "sites.pageTitle", width: "wide" },
	loader: async ({ params, context }) => {
		const api = await getApi();
		const sites = context.place.level === "workspace" ? context.place.sites : [];
		const [storage, activity, cards] = await Promise.all([
			api.workspaces.storage({ workspaceId: params.workspaceId }),
			// Only those who read the Audit log (Staff, Owners) get "Recent activity"; it is never asked for the others.
			context.place.level === "workspace" && context.place.permissions.includes("audit.view")
				? api.audit.list({ workspaceId: params.workspaceId, limit: ACTIVITY }).catch(() => null)
				: null,
			Promise.all(sites.map((site) => siteCardOf(api, site.id))),
		]);
		return {
			storage,
			activity,
			cards: Object.fromEntries(sites.map((site, index) => [site.id, cards[index] ?? null])),
		};
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "sites.pageTitle") }] }),
	component: SitesPage,
});

type WorkspacePlace = Extract<AdminPlace, { level: "workspace" }>;

/** What a Site's card says: its Primary domain and its state, its languages and how many changes wait. */
type SiteCardData = {
	domain: { name: string; status: "active" | "waiting" | "unreachable" } | null;
	staging: string | null;
	languages: string[];
	changes: number;
};

async function siteCardOf(api: Awaited<ReturnType<typeof getApi>>, siteId: string): Promise<SiteCardData | null> {
	try {
		const [domains, { settings }, { count }] = await Promise.all([
			api.domains.list({ siteId }),
			api.languages.list({ siteId }),
			api.publishing.count({ siteId }),
		]);
		const primary = domains.domains.find((domain) => domain.role === "primary");
		return {
			domain: primary ? { name: primary.displayName, status: primary.status } : null,
			staging: domains.stagingUrl ? new URL(domains.stagingUrl).host : null,
			languages: settings.languages.map((language) => language.code),
			changes: count,
		};
	} catch {
		return null;
	}
}

/** Workspace › Sites (frame 06): the Workspace's websites the person reaches, and what happened lately; Staff create them here. */
function SitesPage() {
	const t = useT();
	const place = Route.useRouteContext().place as WorkspacePlace;
	const canCreate = place.permissions.includes("site.create");
	const canImport = place.permissions.includes("site.import");
	const { storage, activity, cards } = Route.useLoaderData();
	const actions =
		canCreate || canImport ? (
			<>
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
			</>
		) : undefined;

	return (
		<>
			<PageHeader heading={t("sites.heading")} action={actions}>
				{t("sites.intro")}
			</PageHeader>
			<div className="grid gap-6">
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
					<ul className="grid gap-6 @2xl/page:grid-cols-2 @4xl/page:grid-cols-3">
						{place.sites.map((site) => (
							<li key={site.id}>
								<SiteCard site={site} card={cards[site.id] ?? null} />
							</li>
						))}
					</ul>
				)}
				{activity ? (
					<div className="@4xl/page:max-w-216">
						<ActivityCard activity={activity} withSite />
					</div>
				) : null}
				<WorkspaceStorage
					workspaceId={place.workspace.id}
					storage={storage}
					canSetQuota={place.permissions.includes("quota.manage")}
				/>
			</div>
		</>
	);
}

/** One Site: a picture, its name and whether its domain is live, the domain, its languages and how many changes wait. */
function SiteCard({ site, card }: { site: { id: string; name: string; slug: string }; card: SiteCardData | null }) {
	const t = useT();
	const facts = [
		card?.languages.map((code) => code.toUpperCase()).join(" · "),
		card && card.changes > 0 ? t("sites.card.changes", { count: card.changes }) : null,
	].filter(Boolean);
	return (
		<article className="bg-card text-card-foreground ring-foreground/10 relative h-full overflow-hidden rounded-xl shadow-xs ring-1">
			<SitePicture />
			<div className="grid gap-1.5 p-4">
				<div className="flex items-center justify-between gap-2">
					<h2 className="min-w-0 truncate text-base font-medium">
						<Link
							to="/sites/$siteId"
							params={{ siteId: site.id }}
							className="focus-visible:ring-ring/50 rounded-sm outline-none after:absolute after:inset-0 hover:underline focus-visible:underline focus-visible:ring-3"
						>
							{site.name}
						</Link>
					</h2>
					{card?.domain ? (
						<DomainState status={card.domain.status} />
					) : (
						<StateBadge tone="neutral">{t("site.overview.noDomainBadge")}</StateBadge>
					)}
				</div>
				<p className="text-muted-foreground truncate font-mono text-sm">
					<span className="sr-only">{t("sites.card.address")}: </span>
					{card?.domain?.name ?? card?.staging ?? site.slug}
				</p>
				{facts.length > 0 ? <p className="text-muted-foreground text-[13px]">{facts.join(" · ")}</p> : null}
			</div>
		</article>
	);
}

/** The card's picture: a Site has none of its own yet, so a quiet drawing in the theme's colours stands in. */
function SitePicture() {
	return (
		<div aria-hidden="true" className="bg-muted relative h-30 overflow-hidden">
			<div className="bg-foreground/5 absolute -end-10 -top-16 size-48 rounded-full" />
			<div className="bg-foreground/10 absolute start-1/5 bottom-4 h-12 w-3/5 rounded-[50%]" />
		</div>
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
		<SettingsCard
			title={t("workspaceStorage.heading")}
			description={t("workspaceStorage.intro")}
			action={canSetQuota ? <QuotaDialog workspaceId={workspaceId} storage={storage} /> : null}
			className="@4xl/page:max-w-216"
		>
			<QuotaNotice storage={storage} />
			<StorageMeter storage={storage} />
			<p className="text-muted-foreground text-sm">
				{storage.quotaBytes === null
					? t("workspaceStorage.noQuota")
					: t("workspaceStorage.quota", { quota: formatBytes(storage.quotaBytes) })}
			</p>
		</SettingsCard>
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
