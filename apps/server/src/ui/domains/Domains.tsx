import { Link, useRouter } from "@tanstack/react-router";
import type { DnsRecord, Edge, PausedDomain, SiteDomain, SiteDomainList } from "@webcraft/core";
import { CDN_KEYS, CDNS, type CdnKey } from "@webcraft/core/cdns";
import { wwwPartnerOf } from "@webcraft/core/domain-partner";
import { STAGING_PASSWORD_MAX_LENGTH, STAGING_PASSWORD_MIN_LENGTH } from "@webcraft/core/staging-rules";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
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
import { Field, FieldDescription, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { RadioGroup, RadioGroupItem } from "@webcraft/ui/components/radio-group.tsx";
import {
	Table,
	TableBody,
	TableCaption,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@webcraft/ui/components/table.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@webcraft/ui/components/tabs.tsx";
import {
	CopyIcon,
	EllipsisIcon,
	ExternalLinkIcon,
	FlaskConicalIcon,
	GlobeIcon,
	LanguagesIcon,
	RefreshCwIcon,
	StarIcon,
	TrashIcon,
} from "lucide-react";
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { formatUtc, formatUtcDate } from "../format.ts";
import { useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";
import { PageHeader } from "../PageHeader.tsx";
import { PasswordInput } from "../PasswordInput.tsx";
import { useOpenStaging } from "../shell/StagingButton.tsx";

/** What the screen shows: the Site's domains, the Install's edge, the Staging address and the Site's CDN. */
export type DomainsData = SiteDomainList & { stagingUrl: string | null; cdn: CdnKey | null; cdnSecret: boolean };

/** The Site's staging password as the screen shows it: whether there is one, never the password. */
export type StagingPasswordState = { set: boolean; changedAt: Date | string | null };

/** A language of the Site, by code, as the language domains card names it. */
type LanguageNames = Readonly<Record<string, string>>;

/**
 * Site › Domains & Staging (variant A of the navigation prototype): the Primary domain, the Redirect
 * domains, the languages' domains and the Staging address. Staff add, check, change and remove
 * domains (`structure.edit`); everyone else who opens it (an Owner following the Domain check's
 * email) sees their state. Like every Site setting, a change applies at once.
 */
export function DomainsPage({
	siteId,
	data,
	canEdit,
	languageNames,
	stagingPassword,
	canManageStaging,
	paused = [],
}: {
	siteId: string;
	data: DomainsData;
	/** The Site's Paused domains (a Site import's), for Staff. */
	paused?: readonly PausedDomain[];
	canEdit: boolean;
	languageNames: LanguageNames;
	/** Whether the Site has a staging password. */
	stagingPassword: StagingPasswordState;
	/** Whether the person may set it (`staging.manage`: Owners and Staff). */
	canManageStaging: boolean;
}) {
	const t = useT();
	const primary = data.domains.find((domain) => domain.role === "primary");
	const redirects = data.domains.filter((domain) => domain.role === "redirect");
	const languages = data.domains.filter((domain) => domain.role === "language");
	const context = { siteId, edge: data.edge, canEdit, primaryName: primary?.displayName ?? "" };
	return (
		<>
			<PageHeader heading={t("domains.heading")}>{t(`domains.intro.${data.edge}`)}</PageHeader>
			<div className="grid max-w-4xl grid-cols-1 gap-8">
				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("domains.primaryTitle")}</h2>
						</CardTitle>
						<CardDescription>{t("domains.primaryIntro")}</CardDescription>
					</CardHeader>
					<CardContent className="grid grid-cols-1 gap-4">
						{primary ? (
							<DomainItem
								{...context}
								domain={primary}
								icon={GlobeIcon}
								action={canEdit ? <ChangePrimary siteId={siteId} primary={primary} redirects={redirects} /> : null}
							/>
						) : (
							<p className="text-muted-foreground text-sm">{t("domains.noPrimary")}</p>
						)}
						{!primary && canEdit ? <AddDomain siteId={siteId} kind="primary" /> : null}
					</CardContent>
				</Card>
				{primary ? (
					<Card>
						<CardHeader>
							<CardTitle>
								<h2>{t("domains.redirectsTitle")}</h2>
							</CardTitle>
							<CardDescription>{t("domains.redirectsIntro")}</CardDescription>
						</CardHeader>
						<CardContent className="grid grid-cols-1 gap-4">
							{redirects.length > 0 ? (
								<ul className="grid grid-cols-1 gap-3">
									{redirects.map((domain) => (
										<li key={domain.id}>
											<DomainItem {...context} domain={domain} menu={canEdit} />
										</li>
									))}
								</ul>
							) : (
								<p className="text-muted-foreground text-sm">{t("domains.noRedirects")}</p>
							)}
							{canEdit ? <AddDomain siteId={siteId} kind="redirect" /> : null}
						</CardContent>
					</Card>
				) : null}
				{languages.length > 0 ? (
					<Card>
						<CardHeader>
							<CardTitle>
								<h2>{t("domains.languagesTitle")}</h2>
							</CardTitle>
							<CardDescription>{t("domains.languagesIntro")}</CardDescription>
						</CardHeader>
						<CardContent className="grid grid-cols-1 gap-4">
							<ul className="grid grid-cols-1 gap-3">
								{languages.map((domain) => (
									<li key={domain.id}>
										<DomainItem
											{...context}
											domain={domain}
											icon={LanguagesIcon}
											note={t("domains.language", {
												name: languageNames[domain.language ?? ""] ?? domain.language ?? "",
											})}
										/>
									</li>
								))}
							</ul>
							{canEdit ? (
								<div>
									<Button
										variant="outline"
										render={<Link to="/sites/$siteId/languages" params={{ siteId }} />}
										nativeButton={false}
									>
										{t("domains.openLanguages")}
									</Button>
								</div>
							) : null}
						</CardContent>
					</Card>
				) : null}
				{canEdit && paused.length > 0 ? (
					<PausedDomains siteId={siteId} paused={paused} languageNames={languageNames} />
				) : null}
				<StagingAddress
					siteId={siteId}
					url={data.stagingUrl}
					password={stagingPassword}
					canManagePassword={canManageStaging}
				/>
				<SiteCdn siteId={siteId} cdn={data.cdn} hasSecret={data.cdnSecret} canEdit={canEdit} />
				<p className="text-muted-foreground text-sm">{t("domains.appliesAtOnce")}</p>
			</div>
		</>
	);
}

type ItemContext = { siteId: string; edge: Edge; canEdit: boolean; primaryName: string };

/**
 * One domain: its name, its status and what the last check found; while it waits for DNS, Check now
 * and the DNS records to create.
 */
function DomainItem({
	siteId,
	edge,
	canEdit,
	primaryName,
	domain,
	icon: Icon,
	action,
	menu,
	note,
}: ItemContext & {
	domain: SiteDomain;
	icon?: typeof GlobeIcon;
	action?: React.ReactNode;
	menu?: boolean;
	note?: string;
}) {
	const t = useT();
	const waiting = domain.status === "waiting";
	return (
		<div className={waiting ? "rounded-lg border" : "bg-muted/40 rounded-lg border"}>
			{/* On a phone the details take a line of their own, under the name and the actions. */}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3 sm:p-4">
				{Icon ? <Icon aria-hidden="true" className="text-muted-foreground size-5 shrink-0" /> : null}
				<span className="font-medium break-all">{domain.displayName}</span>
				<StatusBadge status={domain.status} />
				<span className="text-muted-foreground order-last basis-full text-sm sm:order-none sm:min-w-0 sm:flex-1 sm:basis-0">
					{detailOf(t, domain, note)}
				</span>
				<div className="ms-auto flex shrink-0 items-center gap-2">
					{canEdit && waiting ? <CheckNow siteId={siteId} domain={domain} /> : null}
					{action}
					{menu ? <DomainMenu siteId={siteId} domain={domain} primaryName={primaryName} /> : null}
				</div>
			</div>
			{waiting ? (
				<div className="border-t p-3 sm:p-4">
					<DnsRecords domain={domain} edge={edge} />
				</div>
			) : null}
		</div>
	);
}

type Translate = ReturnType<typeof useT>;

/** What to say about a domain beside its status: its certificate, or what its last check found and when. */
function detailOf(t: Translate, domain: SiteDomain, note?: string): string {
	const parts: string[] = note ? [note] : [];
	if (domain.problem) parts.push(t(`domains.problem.${domain.problem}`));
	if (domain.status === "waiting") {
		parts.push(
			domain.lastCheckedAt
				? t("domains.checkedAt", { time: formatUtc(domain.lastCheckedAt) })
				: t("domains.notChecked"),
		);
		parts.push(
			domain.nextCheckAt ? t("domains.nextCheck", { time: formatUtc(domain.nextCheckAt) }) : t("domains.onDemand"),
		);
	} else if (domain.certificateExpiresAt && !domain.problem) {
		parts.push(t("domains.certificateUntil", { date: formatUtcDate(domain.certificateExpiresAt) }));
	} else if (domain.lastCheckedAt) {
		parts.push(t("domains.checkedAt", { time: formatUtc(domain.lastCheckedAt) }));
	}
	return parts.join(" · ");
}

const STATUS_STYLES: Record<SiteDomain["status"], string> = {
	active: "bg-emerald-600/10 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300",
	waiting: "bg-amber-500/15 text-amber-900 dark:bg-amber-400/15 dark:text-amber-200",
	unreachable: "bg-destructive/10 text-destructive dark:bg-destructive/20",
};

function StatusBadge({ status }: { status: SiteDomain["status"] }) {
	const t = useT();
	return (
		<Badge variant="secondary" className={STATUS_STYLES[status]}>
			{t(`domains.status.${status}`)}
		</Badge>
	);
}

/** Check now: checks the domain at once and says what was found. */
function CheckNow({ siteId, domain }: { siteId: string; domain: SiteDomain }) {
	const t = useT();
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const check = async () => {
		setBusy(true);
		try {
			const api = await getApi();
			const { domain: checked } = await api.domains.check({ siteId, domainId: domain.id });
			if (checked.status === "active" && domain.status === "waiting") {
				toast.success(t("domains.verified", { name: checked.displayName }));
			} else {
				toast(t("domains.checked", { name: checked.displayName }));
			}
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Button variant="outline" size="sm" onClick={check} disabled={busy}>
			<RefreshCwIcon aria-hidden="true" className={busy ? "animate-spin" : undefined} />
			{t("domains.checkNow")}
			<span className="sr-only"> {domain.displayName}</span>
		</Button>
	);
}

/** A Redirect domain's actions: check it now, make it the Primary domain (once verified), remove it. */
function DomainMenu({ siteId, domain, primaryName }: { siteId: string; domain: SiteDomain; primaryName: string }) {
	const t = useT();
	const router = useRouter();
	const trigger = useRef<HTMLButtonElement>(null);
	const [making, setMaking] = useState(false);
	const [removing, setRemoving] = useState(false);
	const check = async () => {
		try {
			const api = await getApi();
			const { domain: checked } = await api.domains.check({ siteId, domainId: domain.id });
			toast(t("domains.checked", { name: checked.displayName }));
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					ref={trigger}
					render={
						<Button variant="ghost" size="icon-sm" aria-label={t("domains.actionsOf", { name: domain.displayName })} />
					}
				>
					<EllipsisIcon aria-hidden="true" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-auto min-w-56">
					{domain.status !== "waiting" ? (
						<>
							<DropdownMenuItem onClick={check}>
								<RefreshCwIcon aria-hidden="true" />
								{t("domains.checkNow")}
							</DropdownMenuItem>
							<DropdownMenuItem onClick={() => setMaking(true)}>
								<StarIcon aria-hidden="true" />
								{t("domains.makePrimary")}
							</DropdownMenuItem>
						</>
					) : null}
					<DropdownMenuItem variant="destructive" onClick={() => setRemoving(true)}>
						<TrashIcon aria-hidden="true" />
						{t("domains.remove")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{making ? (
				<MakePrimaryDialog
					siteId={siteId}
					domain={domain}
					current={primaryName}
					onClose={() => setMaking(false)}
					finalFocus={trigger}
				/>
			) : null}
			{removing ? (
				<RemoveDialog siteId={siteId} domain={domain} onClose={() => setRemoving(false)} finalFocus={trigger} />
			) : null}
		</>
	);
}

type DialogProps = {
	siteId: string;
	domain: SiteDomain;
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
};

/** Makes a verified Redirect domain the Primary domain, after saying what happens to the current one. */
function MakePrimaryDialog({ siteId, domain, onClose, finalFocus, current }: DialogProps & { current?: string }) {
	const t = useT();
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const run = async () => {
		setBusy(true);
		try {
			const api = await getApi();
			await api.domains.makePrimary({ siteId, domainId: domain.id });
			toast.success(t("domains.primaryChanged", { name: domain.displayName }));
			onClose();
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("domains.close")} finalFocus={finalFocus}>
				<DialogHeader>
					<DialogTitle>{t("domains.makePrimaryTitle", { name: domain.displayName })}</DialogTitle>
					<DialogDescription>
						{t("domains.makePrimaryBody", { name: domain.displayName, current: current ?? "" })}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" type="button" />}>{t("domains.cancel")}</DialogClose>
					<Button onClick={run} disabled={busy}>
						{t("domains.makePrimaryConfirm")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Removing a domain, in two steps: the first shows what stops; confirming removes it. */
function RemoveDialog({ siteId, domain, onClose, finalFocus }: DialogProps) {
	const t = useT();
	const router = useRouter();
	const [asked, setAsked] = useState<{ live: boolean; primary: boolean; confirmation: string } | null>(null);
	const [busy, setBusy] = useState(false);
	const run = async () => {
		setBusy(true);
		try {
			const api = await getApi();
			const answer = await api.domains.remove({
				siteId,
				domainId: domain.id,
				...(asked ? { confirmation: asked.confirmation } : {}),
			});
			if (!answer.removed) {
				setAsked({
					live: answer.preview.live,
					primary: answer.preview.role === "primary",
					confirmation: answer.confirmation.id,
				});
				return;
			}
			toast.success(t("domains.removed", { name: domain.displayName }));
			onClose();
			await router.invalidate();
			document.getElementById("main")?.focus();
		} catch (failure) {
			setAsked(null);
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("domains.close")} finalFocus={finalFocus}>
				<DialogHeader>
					<DialogTitle>{t("domains.removeTitle", { name: domain.displayName })}</DialogTitle>
					<DialogDescription>{t("domains.removeBody")}</DialogDescription>
				</DialogHeader>
				{asked ? (
					<div className="my-4 grid gap-2 text-sm" aria-live="polite">
						<p>
							{asked.live
								? t("domains.removeLive", { name: domain.displayName })
								: t("domains.removeWaiting", { name: domain.displayName })}
						</p>
						{asked.primary ? <p>{t("domains.removePrimary")}</p> : null}
					</div>
				) : null}
				<DialogFooter>
					<DialogClose render={<Button variant="outline" type="button" />}>{t("domains.cancel")}</DialogClose>
					<Button variant={asked ? "destructive" : "default"} onClick={run} disabled={busy}>
						{asked ? t("domains.removeConfirm") : t("domains.checkChanges")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Change: the Primary domain's own actions. A verified Redirect domain can take over; the Primary
 * domain itself can be checked again or removed.
 */
function ChangePrimary({
	siteId,
	primary,
	redirects,
}: {
	siteId: string;
	primary: SiteDomain;
	redirects: readonly SiteDomain[];
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const trigger = useRef<HTMLButtonElement>(null);
	const verified = redirects.filter((domain) => domain.status !== "waiting");
	const [open, setOpen] = useState(false);
	const [chosen, setChosen] = useState(verified[0]?.id ?? "");
	const [removing, setRemoving] = useState(false);
	const [busy, setBusy] = useState(false);
	const save = async (event: FormEvent) => {
		event.preventDefault();
		const domain = verified.find((candidate) => candidate.id === chosen);
		if (!domain) return;
		setBusy(true);
		try {
			const api = await getApi();
			await api.domains.makePrimary({ siteId, domainId: domain.id });
			toast.success(t("domains.primaryChanged", { name: domain.displayName }));
			setOpen(false);
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			{primary.status !== "waiting" ? <CheckNow siteId={siteId} domain={primary} /> : null}
			<Button ref={trigger} variant="outline" size="sm" onClick={() => setOpen(true)}>
				{t("domains.change")}
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={`${t("domains.remove")} ${primary.displayName}`}
				onClick={() => setRemoving(true)}
			>
				<TrashIcon aria-hidden="true" />
			</Button>
			{open ? (
				<Dialog open onOpenChange={(next) => !next && setOpen(false)}>
					<DialogContent closeLabel={t("domains.close")} finalFocus={trigger}>
						<form onSubmit={save}>
							<DialogHeader>
								<DialogTitle>{t("domains.changeTitle")}</DialogTitle>
								<DialogDescription>
									{verified.length > 0 ? t("domains.changeIntro") : t("domains.changeNone")}
								</DialogDescription>
							</DialogHeader>
							{verified.length > 0 ? (
								<RadioGroup
									className="my-6"
									value={chosen}
									onValueChange={(value) => setChosen(String(value))}
									aria-label={t("domains.changeTitle")}
								>
									{verified.map((domain) => (
										<Field key={domain.id} orientation="horizontal">
											<RadioGroupItem id={`${id}-${domain.id}`} value={domain.id} />
											<FieldLabel htmlFor={`${id}-${domain.id}`}>{domain.displayName}</FieldLabel>
										</Field>
									))}
								</RadioGroup>
							) : null}
							<DialogFooter className={verified.length > 0 ? undefined : "mt-6"}>
								<DialogClose render={<Button variant="outline" type="button" />}>{t("domains.cancel")}</DialogClose>
								{verified.length > 0 ? (
									<Button type="submit" disabled={busy || !chosen}>
										{t("domains.makePrimaryConfirm")}
									</Button>
								) : null}
							</DialogFooter>
						</form>
					</DialogContent>
				</Dialog>
			) : null}
			{removing ? (
				<RemoveDialog siteId={siteId} domain={primary} onClose={() => setRemoving(false)} finalFocus={trigger} />
			) : null}
		</>
	);
}

/** A bare domain and its `www` address, offered together: the other one of the pair, as typed so far. */
function partnerOf(name: string): string | null {
	const typed = name.trim().toLowerCase().replace(/\.$/, "");
	if (!/^[^\s/:]+\.[^\s/:]+$/.test(typed)) return null;
	return wwwPartnerOf(typed);
}

/**
 * Adding a domain: the Primary domain when the Site has none, else a Redirect domain. Its `www`
 * address (or, for `www.…`, the bare domain) is offered with it, ticked for a bare domain.
 */
function AddDomain({ siteId, kind }: { siteId: string; kind: "primary" | "redirect" }) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const [name, setName] = useState("");
	const [withPartner, setWithPartner] = useState<boolean | null>(null);
	const [busy, setBusy] = useState(false);
	const partner = partnerOf(name);
	// Ticked by default for `bakery.ie` and `www.bakery.ie`, not for deeper names such as `shop.bakery.ie`.
	const suggested = partner !== null && (name.trim().toLowerCase().startsWith("www.") || name.split(".").length === 2);
	const adding = partner !== null && (withPartner ?? suggested);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		try {
			const api = await getApi();
			const { domains } = await api.domains.add({ siteId, name, withPartner: adding });
			const [first, second] = domains;
			toast.success(
				second
					? t("domains.addedTwo", { name: first?.displayName ?? "", partner: second.displayName })
					: t("domains.addedOne", { name: first?.displayName ?? name }),
			);
			setName("");
			setWithPartner(null);
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	const label = kind === "primary" ? t("domains.addLabel") : t("domains.addRedirectLabel");
	return (
		<form onSubmit={submit} noValidate className="grid gap-3">
			<Field>
				<FieldLabel htmlFor={`${id}-name`} className={kind === "redirect" ? "sr-only" : undefined}>
					{label}
				</FieldLabel>
				<div className="flex flex-col gap-2 sm:flex-row">
					<Input
						id={`${id}-name`}
						value={name}
						maxLength={253}
						autoComplete="off"
						spellCheck={false}
						inputMode="url"
						placeholder={kind === "primary" ? t("domains.addPrimaryPlaceholder") : t("domains.addRedirectPlaceholder")}
						onChange={(event) => setName(event.target.value)}
						aria-describedby={partner ? `${id}-partner-help` : undefined}
					/>
					<Button type="submit" variant={kind === "primary" ? "default" : "outline"} disabled={busy || !name.trim()}>
						{t("domains.add")}
					</Button>
				</div>
			</Field>
			{partner ? (
				<Field orientation="horizontal">
					<Checkbox
						id={`${id}-partner`}
						checked={adding}
						onCheckedChange={(value) => setWithPartner(value === true)}
						aria-describedby={`${id}-partner-help`}
					/>
					<div className="grid gap-1">
						<FieldLabel htmlFor={`${id}-partner`}>{t("domains.addPartner", { name: partner })}</FieldLabel>
						<FieldDescription id={`${id}-partner-help`}>{t("domains.addPartnerHelp")}</FieldDescription>
					</div>
				</Field>
			) : null}
		</form>
	);
}

/**
 * The DNS records that point a domain at the Install, for each place an Install runs (ADR 0015), the
 * Install's own first: Caddy on a VPS issues the certificate by itself; on Coolify and Railway the
 * domain is also added in the platform's panel.
 */
function DnsRecords({ domain, edge }: { domain: SiteDomain; edge: Edge }) {
	const t = useT();
	const edges: Edge[] = ["caddy", "coolify", "railway"];
	return (
		<Tabs defaultValue={edge} className="min-w-0">
			<TabsList aria-label={t("domains.records.platforms")} activateOnFocus>
				{edges.map((candidate) => (
					<TabsTrigger key={candidate} value={candidate}>
						{t(`domains.records.${candidate}`)}
					</TabsTrigger>
				))}
			</TabsList>
			{edges.map((candidate) => (
				<TabsContent key={candidate} value={candidate} className="grid grid-cols-1 gap-4 pt-2">
					<p className="text-muted-foreground">{t(`domains.records.${candidate}Intro`, { name: domain.name })}</p>
					{candidate === "railway" ? null : <RecordTables domain={domain} />}
				</TabsContent>
			))}
		</Tabs>
	);
}

function RecordTables({ domain }: { domain: SiteDomain }) {
	const t = useT();
	const { address, alias } = domain.records;
	return (
		<>
			<RecordTable name={domain.name} records={address.length > 0 ? address : [alias]} />
			{address.length > 0 ? (
				<p className="text-muted-foreground flex flex-wrap items-center gap-1">
					{t("domains.records.aliasIntro", { host: alias.value })}
					<CopyButton value={alias.value} />
				</p>
			) : (
				<p className="text-muted-foreground">{t("domains.records.noAddresses")}</p>
			)}
		</>
	);
}

function RecordTable({ name, records }: { name: string; records: readonly DnsRecord[] }) {
	const t = useT();
	return (
		<div className="rounded-md border">
			<Table>
				<TableCaption className="sr-only">{t("domains.records.caption", { name })}</TableCaption>
				<TableHeader>
					<TableRow>
						<TableHead>{t("domains.records.type")}</TableHead>
						<TableHead>{t("domains.records.name")}</TableHead>
						<TableHead>{t("domains.records.value")}</TableHead>
						<TableHead className="text-end">{t("domains.records.ttl")}</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{records.map((record) => (
						<TableRow key={`${record.type} ${record.value}`}>
							<TableCell className="font-mono">{record.type}</TableCell>
							<TableCell className="font-mono">{record.name}</TableCell>
							<TableCell>
								<span className="inline-flex items-center gap-1 font-mono">
									{record.value}
									<CopyButton value={record.value} />
								</span>
							</TableCell>
							<TableCell className="text-end">{t("domains.records.auto")}</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

/** Copies a value (a record's value, an address) and says so. */
function CopyButton({ value }: { value: string }) {
	const t = useT();
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(value);
			toast.success(t("domains.copied"));
		} catch {
			toast.error(t("errors.generic"));
		}
	};
	return (
		<Button variant="ghost" size="icon-xs" aria-label={t("domains.copy", { value })} onClick={copy}>
			<CopyIcon aria-hidden="true" />
		</Button>
	);
}

/**
 * The CDN in front of the Site: with one chosen, and the Site's CDN secret set up there, visitors'
 * requests from the CDN's published addresses count as coming from the visitor the CDN names, so rate
 * limits keep counting visitors. Staff choose it and make the secret; everyone else who sees the Site
 * sees which CDN and whether it has a secret.
 */
function SiteCdn({
	siteId,
	cdn,
	hasSecret,
	canEdit,
}: {
	siteId: string;
	cdn: CdnKey | null;
	hasSecret: boolean;
	canEdit: boolean;
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const [chosen, setChosen] = useState<string>(cdn ?? "none");
	const [busy, setBusy] = useState(false);
	const save = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		try {
			const api = await getApi();
			const next = CDN_KEYS.find((key) => key === chosen) ?? null;
			await api.domains.setCdn({ siteId, cdn: next });
			toast.success(next ? t("domains.cdnSaved", { name: CDNS[next].name }) : t("domains.cdnRemoved"));
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	const label = (key: CdnKey) => t("domains.cdnOption", { name: CDNS[key].name, header: headerName(CDNS[key].header) });
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2 id={`${id}-title`}>{t("domains.cdnTitle")}</h2>
				</CardTitle>
				<CardDescription>{t("domains.cdnIntro")}</CardDescription>
			</CardHeader>
			<CardContent className="grid grid-cols-1 gap-4">
				{canEdit ? (
					<form onSubmit={save} className="grid grid-cols-1 gap-4">
						<RadioGroup
							value={chosen}
							onValueChange={(value) => setChosen(String(value))}
							aria-labelledby={`${id}-title`}
						>
							<Field orientation="horizontal">
								<RadioGroupItem id={`${id}-none`} value="none" />
								<FieldLabel htmlFor={`${id}-none`}>{t("domains.cdnNone")}</FieldLabel>
							</Field>
							{CDN_KEYS.map((key) => (
								<Field key={key} orientation="horizontal">
									<RadioGroupItem id={`${id}-${key}`} value={key} />
									<FieldLabel htmlFor={`${id}-${key}`}>{label(key)}</FieldLabel>
								</Field>
							))}
						</RadioGroup>
						<p className="text-muted-foreground text-sm">{t("domains.cdnSteps")}</p>
						<div>
							<Button type="submit" variant="outline" size="sm" disabled={busy || chosen === (cdn ?? "none")}>
								{t("domains.cdnSave")}
							</Button>
						</div>
					</form>
				) : (
					<p className="text-sm">{cdn ? label(cdn) : t("domains.cdnNone")}</p>
				)}
				{cdn ? <CdnSecret key={cdn} siteId={siteId} cdn={cdn} hasSecret={hasSecret} canEdit={canEdit} /> : null}
			</CardContent>
		</Card>
	);
}

/**
 * The Site's CDN secret: what the Site's own service at the CDN sends with every request, so the Site
 * knows a request came through it and not through someone else's service at the same CDN. Staff make
 * it; it is shown once, with the header to send it in.
 */
function CdnSecret({
	siteId,
	cdn,
	hasSecret,
	canEdit,
}: {
	siteId: string;
	cdn: CdnKey;
	hasSecret: boolean;
	canEdit: boolean;
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const [made, setMade] = useState<{ secret: string; header: string } | null>(null);
	const [busy, setBusy] = useState(false);
	const name = CDNS[cdn].name;
	const make = async () => {
		setBusy(true);
		try {
			const api = await getApi();
			setMade(await api.domains.newCdnSecret({ siteId }));
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	return (
		<section aria-labelledby={`${id}-title`} className="grid grid-cols-1 gap-2 border-t pt-4">
			<h3 id={`${id}-title`} className="text-sm font-medium">
				{t("domains.cdnSecretTitle")}
			</h3>
			<p className="text-muted-foreground text-sm">{t("domains.cdnSecretIntro", { name })}</p>
			<p className="text-sm" role="status">
				{hasSecret ? t("domains.cdnSecretSet") : t("domains.cdnSecretMissing", { name })}
			</p>
			{made ? (
				<div className="grid grid-cols-1 gap-1 text-sm">
					<p>{t("domains.cdnSecretShown", { name })}</p>
					<p className="flex flex-wrap items-center gap-1">
						<code className="break-all">{`${made.header}: ${made.secret}`}</code>
						<CopyButton value={made.secret} />
					</p>
				</div>
			) : null}
			{canEdit ? (
				<div>
					<Button type="button" variant="outline" size="sm" disabled={busy} onClick={make}>
						{hasSecret ? t("domains.cdnSecretRemake") : t("domains.cdnSecretMake")}
					</Button>
				</div>
			) : null}
		</section>
	);
}

/** A header's name as people write it: `cf-connecting-ip` is `CF-Connecting-IP`. */
function headerName(header: string): string {
	return header
		.split("-")
		.map((part) =>
			part === "ip" || part === "cf" ? part.toUpperCase() : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`,
		)
		.join("-");
}

/**
 * The Staging address: the Site with all its Drafts on the agency's own domain, never indexed (ADR
 * 0014). Opening it goes through a single-use link, so the browser is let in there; people without an
 * account get in with the staging password, which Owners and Staff set here.
 */
function StagingAddress({
	siteId,
	url,
	password,
	canManagePassword,
}: {
	siteId: string;
	url: string | null;
	password: StagingPasswordState;
	canManagePassword: boolean;
}) {
	const t = useT();
	const address = url ? new URL(url).host : null;
	const { opening, open: openPath } = useOpenStaging(siteId);
	const open = () => openPath("/");
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t("domains.stagingTitle")}</h2>
				</CardTitle>
				<CardDescription>{t("domains.stagingIntro")}</CardDescription>
			</CardHeader>
			<CardContent className="grid gap-6">
				{url && address ? (
					<div className="bg-muted/40 flex flex-wrap items-center gap-3 rounded-lg border p-3 sm:p-4">
						<FlaskConicalIcon aria-hidden="true" className="text-muted-foreground size-5 shrink-0" />
						<span className="min-w-0 flex-1 font-mono text-sm break-all">{address}</span>
						<CopyButton value={url} />
						<Button
							variant="outline"
							size="sm"
							onClick={open}
							disabled={opening}
							aria-label={t("domains.openLabel", { address })}
						>
							<ExternalLinkIcon aria-hidden="true" />
							{t("domains.open")}
						</Button>
					</div>
				) : (
					<p className="text-muted-foreground text-sm">{t("domains.noStaging")}</p>
				)}
				{url ? <StagingPassword siteId={siteId} password={password} canManage={canManagePassword} /> : null}
			</CardContent>
		</Card>
	);
}

/** Letters and digits nobody mixes up when reading a password out: no 0/O, 1/l/I. */
const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** A new staging password: four groups of four characters, 80 random bits. */
function generatedPassword(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const characters = Array.from(bytes, (byte) => PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]);
	return [0, 4, 8, 12].map((start) => characters.slice(start, start + 4).join("")).join("-");
}

/**
 * The Site's staging password: whether there is one, and for Owners and Staff a field to set a new
 * one (typed, or generated) and a button to remove it. Setting it is a Sensitive action: the admin
 * asks who they are first when their last check is old.
 */
function StagingPassword({
	siteId,
	password,
	canManage,
}: {
	siteId: string;
	password: StagingPasswordState;
	canManage: boolean;
}) {
	const t = useT();
	const id = useId();
	const router = useRouter();
	const runSensitive = useSensitiveAction();
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const save = async (next: string | null) => {
		setBusy(true);
		try {
			await runSensitive(async () => (await getApi()).staging.setPassword({ siteId, password: next }));
			toast.success(next === null ? t("domains.stagingPasswordRemoved") : t("domains.stagingPasswordSaved"));
			setValue("");
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	const submit = (event: FormEvent) => {
		event.preventDefault();
		void save(value);
	};
	return (
		<section aria-labelledby={`${id}-title`} className="grid gap-3 border-t pt-4">
			<div className="grid gap-1">
				<h3 id={`${id}-title`} className="font-medium">
					{t("domains.stagingPassword")}
				</h3>
				<p className="text-muted-foreground text-sm">{t("domains.stagingPasswordHelp")}</p>
				<p className="text-sm">
					{password.set && password.changedAt
						? t("domains.stagingPasswordSet", { date: formatUtc(password.changedAt) })
						: t("domains.stagingPasswordNone")}
				</p>
			</div>
			{canManage ? (
				<form onSubmit={submit} className="grid gap-3">
					<Field>
						<FieldLabel htmlFor={`${id}-password`}>
							{password.set ? t("domains.stagingPasswordNew") : t("domains.stagingPasswordLabel")}
						</FieldLabel>
						<div className="flex flex-wrap gap-2">
							<div className="min-w-0 flex-1">
								<PasswordInput
									id={`${id}-password`}
									value={value}
									onChange={(event) => setValue(event.target.value)}
									autoComplete="new-password"
									minLength={STAGING_PASSWORD_MIN_LENGTH}
									maxLength={STAGING_PASSWORD_MAX_LENGTH}
									aria-describedby={`${id}-rules`}
								/>
							</div>
							<Button
								type="button"
								variant="outline"
								onClick={() => {
									setValue(generatedPassword());
									toast.info(t("domains.stagingPasswordGenerated"));
								}}
							>
								<RefreshCwIcon aria-hidden="true" />
								{t("domains.stagingPasswordGenerate")}
							</Button>
						</div>
						<FieldDescription id={`${id}-rules`}>{t("domains.stagingPasswordRules")}</FieldDescription>
					</Field>
					<div className="flex flex-wrap gap-2">
						<Button type="submit" size="sm" disabled={busy || value.trim().length < STAGING_PASSWORD_MIN_LENGTH}>
							{t("domains.stagingPasswordSave")}
						</Button>
						{password.set ? (
							<Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void save(null)}>
								{t("domains.stagingPasswordRemove")}
							</Button>
						) : null}
					</div>
				</form>
			) : null}
		</section>
	);
}

/**
 * The Site's Paused domains (a Site import brought them, ADR 0033): each is switched on (added, then
 * verified like any new domain) once it is free on this Install, or discarded.
 */
function PausedDomains({
	siteId,
	paused,
	languageNames,
}: {
	siteId: string;
	paused: readonly PausedDomain[];
	languageNames: LanguageNames;
}) {
	const t = useT();
	const router = useRouter();
	const [busy, setBusy] = useState<string | null>(null);
	const act = async (domain: PausedDomain, action: "switchOn" | "discard") => {
		setBusy(domain.id);
		try {
			const api = await getApi();
			if (action === "switchOn") await api.domains.switchOnPaused({ siteId, pausedId: domain.id });
			else await api.domains.discardPaused({ siteId, pausedId: domain.id });
			toast.success(
				t(action === "switchOn" ? "domains.switchedOn" : "domains.discarded", { name: domain.displayName }),
			);
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(null);
		}
	};
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t("domains.pausedTitle")}</h2>
				</CardTitle>
				<CardDescription>{t("domains.pausedIntro")}</CardDescription>
			</CardHeader>
			<CardContent>
				<ul className="grid grid-cols-1 gap-3">
					{paused.map((domain) => (
						<li key={domain.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
							<div className="grid gap-1">
								<span className="font-medium">{domain.displayName}</span>
								<span className="text-muted-foreground text-sm">
									{domain.role === "language"
										? t("domains.pausedRole.language", {
												name: languageNames[domain.language ?? ""] ?? domain.language ?? "",
											})
										: t(`domains.pausedRole.${domain.role}`)}
								</span>
							</div>
							<div className="flex gap-2">
								<Button
									size="sm"
									disabled={busy !== null}
									aria-label={t("domains.switchOnLabel", { name: domain.displayName })}
									onClick={() => void act(domain, "switchOn")}
								>
									{t("domains.switchOn")}
								</Button>
								<Button
									size="sm"
									variant="outline"
									disabled={busy !== null}
									aria-label={t("domains.discardLabel", { name: domain.displayName })}
									onClick={() => void act(domain, "discard")}
								>
									{t("domains.discard")}
								</Button>
							</div>
						</li>
					))}
				</ul>
			</CardContent>
		</Card>
	);
}
