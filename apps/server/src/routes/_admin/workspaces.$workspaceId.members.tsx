import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { Avatar, AvatarFallback } from "@webcraft/ui/components/avatar.tsx";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
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
import { InputGroup, InputGroupAddon, InputGroupInput } from "@webcraft/ui/components/input-group.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { EllipsisIcon, SearchIcon, UserCogIcon, UserMinusIcon } from "lucide-react";
import { type RefObject, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../../ui/api.ts";
import { errorMessage } from "../../ui/errors.ts";
import { formatUtcDate } from "../../ui/format.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import {
	type AccessOffer,
	ChangeAccessSheet,
	InviteMemberSheet,
	type Member,
	type MemberInvite,
	type SiteOption,
} from "../../ui/members/MemberSheets.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";
import { initials } from "../../ui/shell/context.ts";
import type { AdminPlace } from "../../ui/shell/levels.ts";

export const Route = createFileRoute("/_admin/workspaces/$workspaceId/members")({
	staticData: { crumb: "members.pageTitle" },
	loader: async ({ context, params }) => {
		if (!context.place.permissions.includes("member.manage")) return null;
		const api = await getApi();
		return api.members.list({ workspaceId: params.workspaceId });
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "members.pageTitle") }] }),
	component: MembersPage,
});

type WorkspacePlace = Extract<AdminPlace, { level: "workspace" }>;

const ROLE_FILTERS = ["all", "owner", "editor", "author"] as const;

type RoleFilter = (typeof ROLE_FILTERS)[number];

/**
 * Workspace › Members: the client's people with their role and Sites, pending Member invites, and a
 * read-only list of the agency Staff assigned to the Workspace. Staff and Owners manage them here.
 */
function MembersPage() {
	const t = useT();
	const data = Route.useLoaderData();
	const { place: reached, person } = Route.useRouteContext();
	const place = reached as WorkspacePlace;
	const [query, setQuery] = useState("");
	const [role, setRole] = useState<RoleFilter>("all");
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;

	const canInvite = place.permissions.includes("member.invite") && data.offer.length > 0;
	const sites: SiteOption[] = place.sites.map(({ id, name }) => ({ id, name }));
	const search = query.trim().toLocaleLowerCase();
	const shown = data.members.filter(
		(member) =>
			(role === "all" || member.role === role) &&
			(!search ||
				member.name.toLocaleLowerCase().includes(search) ||
				member.email.toLocaleLowerCase().includes(search)),
	);

	return (
		<>
			<PageHeader
				heading={t("members.heading")}
				action={
					canInvite ? (
						<InviteMemberSheet workspaceId={place.workspace.id} offer={data.offer} sites={sites} />
					) : undefined
				}
			>
				{t("members.intro", { workspace: place.workspace.name })}
			</PageHeader>
			<div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_16rem]">
				<div className="grid min-w-0 content-start gap-10">
					<div className="grid gap-4">
						<div className="flex flex-wrap items-end justify-between gap-3">
							<div className="grid w-full max-w-xs gap-1.5">
								<Label htmlFor="members-search" className="sr-only">
									{t("members.search")}
								</Label>
								<InputGroup>
									<InputGroupAddon>
										<SearchIcon aria-hidden="true" />
									</InputGroupAddon>
									<InputGroupInput
										id="members-search"
										type="search"
										placeholder={t("members.search")}
										value={query}
										onChange={(event) => setQuery(event.target.value)}
									/>
								</InputGroup>
							</div>
							<div className="grid gap-1.5">
								<Label htmlFor="members-role" className="sr-only">
									{t("members.roleFilter")}
								</Label>
								<NativeSelect
									id="members-role"
									value={role}
									onChange={(event) => setRole(event.target.value as RoleFilter)}
								>
									{ROLE_FILTERS.map((filter) => (
										<NativeSelectOption key={filter} value={filter}>
											{filter === "all" ? t("members.allRoles") : t(`roles.${filter}`)}
										</NativeSelectOption>
									))}
								</NativeSelect>
							</div>
						</div>
						{data.members.length === 0 ? (
							<p className="text-muted-foreground rounded-lg border border-dashed p-8 text-center">
								{t("members.empty")}
							</p>
						) : (
							<div className="rounded-lg border">
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead className="ps-4">{t("members.columns.member")}</TableHead>
											<TableHead>{t("members.columns.role")}</TableHead>
											<TableHead>{t("members.columns.sites")}</TableHead>
											<TableHead className="pe-4 text-end">
												<span className="sr-only">{t("members.columns.actions")}</span>
											</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{shown.length === 0 ? (
											<TableRow>
												<TableCell colSpan={4} className="text-muted-foreground p-6 text-center">
													{t("members.noMatch")}
												</TableCell>
											</TableRow>
										) : (
											shown.map((member) => (
												<TableRow key={member.id}>
													<TableCell className="ps-4">
														<div className="flex items-center gap-3">
															<Avatar>
																<AvatarFallback aria-hidden="true">{initials(member.name)}</AvatarFallback>
															</Avatar>
															<div className="min-w-0">
																<span className="block font-medium">
																	{member.name}
																	{member.id === person.id ? (
																		<span className="text-muted-foreground font-normal"> ({t("members.you")})</span>
																	) : null}
																</span>
																<span className="text-muted-foreground block text-xs">{member.email}</span>
															</div>
														</div>
													</TableCell>
													<TableCell>
														<Badge variant="secondary">{t(`roles.${member.role as AccessOffer["role"]}`)}</Badge>
													</TableCell>
													<TableCell className="whitespace-normal">
														<SiteAccessText access={member} />
													</TableCell>
													<TableCell className="pe-4 text-end">
														{member.manageable ? (
															<MemberActions
																member={member}
																workspace={place.workspace}
																offer={data.offer}
																sites={sites}
																isYou={member.id === person.id}
															/>
														) : null}
													</TableCell>
												</TableRow>
											))
										)}
									</TableBody>
								</Table>
							</div>
						)}
					</div>
					<PendingInvites invites={data.invites} workspaceId={place.workspace.id} canInvite={canInvite} />
				</div>
				<div className="grid content-start gap-4">
					<AgencyStaff staff={data.staff} workspace={place.workspace.name} />
					<RolesCard />
				</div>
			</div>
		</>
	);
}

/** "All Sites", or the Sites the person can see by name and how many more there are. */
function SiteAccessText({ access }: { access: { sites: "all" | SiteOption[]; otherSites: number } }) {
	const t = useT();
	if (access.sites === "all") return <>{t("members.allSites")}</>;
	const names = access.sites.map(({ name }) => name).join(", ");
	if (access.sites.length === 0) {
		return (
			<>{access.otherSites > 0 ? t("members.onlyOtherSites", { count: access.otherSites }) : t("members.noSites")}</>
		);
	}
	return (
		<>
			{access.otherSites > 0
				? t("members.someAndOtherSites", { names, count: access.otherSites })
				: t("members.someSites", { names })}
		</>
	);
}

/** A Member's row menu: change their role and Sites, or remove them from the Workspace. */
function MemberActions({
	member,
	workspace,
	offer,
	sites,
	isYou,
}: {
	member: Member;
	workspace: { id: string; name: string };
	offer: readonly AccessOffer[];
	sites: readonly SiteOption[];
	isYou: boolean;
}) {
	const t = useT();
	const trigger = useRef<HTMLButtonElement>(null);
	const [changing, setChanging] = useState(false);
	const [removing, setRemoving] = useState(false);
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					ref={trigger}
					render={<Button variant="ghost" size="icon-sm" aria-label={t("members.actionsOf", { name: member.name })} />}
				>
					<EllipsisIcon aria-hidden="true" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-auto min-w-48">
					<DropdownMenuItem onClick={() => setChanging(true)}>
						<UserCogIcon aria-hidden="true" />
						{t("members.changeAccess")}
					</DropdownMenuItem>
					<DropdownMenuItem variant="destructive" onClick={() => setRemoving(true)}>
						<UserMinusIcon aria-hidden="true" />
						{t("members.remove")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<ChangeAccessSheet
				workspaceId={workspace.id}
				member={member}
				offer={offer}
				sites={sites}
				open={changing}
				onOpenChange={setChanging}
				finalFocus={trigger}
			/>
			<RemoveMemberDialog
				member={member}
				workspace={workspace}
				open={removing}
				onOpenChange={setRemoving}
				finalFocus={trigger}
				isYou={isYou}
			/>
		</>
	);
}

/** Asks before removing a Member: they lose the Workspace at once. */
function RemoveMemberDialog({
	member,
	workspace,
	open,
	onOpenChange,
	finalFocus,
	isYou,
}: {
	member: Member;
	workspace: { id: string; name: string };
	open: boolean;
	onOpenChange: (open: boolean) => void;
	finalFocus: RefObject<HTMLElement | null>;
	isYou: boolean;
}) {
	const t = useT();
	const router = useRouter();
	const navigate = useNavigate();
	const [busy, setBusy] = useState(false);
	const remove = async () => {
		setBusy(true);
		try {
			const api = await getApi();
			await api.members.remove({ workspaceId: workspace.id, personId: member.id });
			toast.success(t("members.removeDialog.removed", { name: member.name, workspace: workspace.name }));
			onOpenChange(false);
			// Removing yourself leaves the Workspace: its pages are out of reach from now on.
			if (isYou) await navigate({ to: "/" });
			else {
				await router.invalidate();
				document.getElementById("main")?.focus();
			}
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent closeLabel={t("members.removeDialog.close")} finalFocus={finalFocus}>
				<DialogHeader>
					<DialogTitle>{t("members.removeDialog.title", { name: member.name })}</DialogTitle>
					<DialogDescription>
						{t("members.removeDialog.body", { name: member.name, workspace: workspace.name })}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" type="button" />}>
						{t("members.removeDialog.cancel")}
					</DialogClose>
					<Button variant="destructive" onClick={remove} disabled={busy}>
						{t("members.removeDialog.confirm")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Pending Member invites, with Resend and Revoke for those the person may manage. */
function PendingInvites({
	invites,
	workspaceId,
	canInvite,
}: {
	invites: readonly MemberInvite[];
	workspaceId: string;
	canInvite: boolean;
}) {
	const t = useT();
	return (
		<section aria-labelledby="pending-invites" className="grid gap-4">
			<h2 id="pending-invites" className="text-lg font-semibold tracking-tight">
				{t("members.pending.heading")}
			</h2>
			{invites.length === 0 ? (
				<p className="text-muted-foreground">{t("members.pending.empty")}</p>
			) : (
				<div className="rounded-lg border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="ps-4">{t("members.pending.email")}</TableHead>
								<TableHead>{t("members.pending.role")}</TableHead>
								<TableHead>{t("members.pending.sites")}</TableHead>
								<TableHead className="pe-4 text-end">
									<span className="sr-only">{t("members.pending.actions")}</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{invites.map((invite) => (
								<TableRow key={invite.id}>
									<TableCell className="ps-4">
										<span className="block font-medium">{invite.email}</span>
										<span className="text-muted-foreground block text-xs">
											{invite.invitedBy
												? t("members.pending.invitedBy", {
														name: invite.invitedBy.name,
														date: formatUtcDate(invite.expiresAt),
													})
												: t("members.pending.expires", { date: formatUtcDate(invite.expiresAt) })}
										</span>
									</TableCell>
									<TableCell>
										<Badge variant="secondary">{t(`roles.${invite.role as AccessOffer["role"]}`)}</Badge>
									</TableCell>
									<TableCell className="whitespace-normal">
										<SiteAccessText access={invite} />
									</TableCell>
									<TableCell className="pe-4 text-end">
										{canInvite && invite.manageable ? (
											<InviteActions invite={invite} workspaceId={workspaceId} />
										) : null}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
		</section>
	);
}

/** Sends a pending invite again with a new link, or withdraws it. */
function InviteActions({ invite, workspaceId }: { invite: MemberInvite; workspaceId: string }) {
	const t = useT();
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const act = async (action: "resend" | "revoke") => {
		setBusy(true);
		try {
			const api = await getApi();
			if (action === "resend") {
				await api.members.resendInvite({ workspaceId, inviteId: invite.id });
				toast.success(t("members.pending.resent", { email: invite.email }));
			} else {
				await api.members.revokeInvite({ workspaceId, inviteId: invite.id });
				toast.success(t("members.pending.revoked", { email: invite.email }));
				document.getElementById("main")?.focus();
			}
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="flex justify-end gap-2">
			<Button
				variant="outline"
				size="sm"
				onClick={() => act("resend")}
				disabled={busy}
				aria-label={t("members.pending.resendOf", { email: invite.email })}
			>
				{t("members.pending.resend")}
			</Button>
			<Button
				variant="ghost"
				size="sm"
				onClick={() => act("revoke")}
				disabled={busy}
				aria-label={t("members.pending.revokeOf", { email: invite.email })}
			>
				{t("members.pending.revoke")}
			</Button>
		</div>
	);
}

/** The agency Staff assigned to the Workspace: read-only here; the Superadmin manages Staff. */
function AgencyStaff({ staff, workspace }: { staff: readonly { id: string; name: string }[]; workspace: string }) {
	const t = useT();
	const { shell } = Route.useRouteContext();
	return (
		<Card size="sm">
			<CardHeader>
				<CardTitle>
					<h2>{t("members.staff.heading")}</h2>
				</CardTitle>
				<CardDescription>{t("members.staff.body", { agency: shell.install.name ?? t("app.name") })}</CardDescription>
			</CardHeader>
			<CardContent className="grid gap-3 text-sm">
				<p className="text-muted-foreground">{t("members.staff.count", { count: staff.length, workspace })}</p>
				{staff.length > 0 ? (
					<ul className="grid gap-2">
						{staff.map((person) => (
							<li key={person.id} className="flex items-center gap-2">
								<Avatar size="sm">
									<AvatarFallback aria-hidden="true">{initials(person.name)}</AvatarFallback>
								</Avatar>
								{person.name}
							</li>
						))}
					</ul>
				) : null}
			</CardContent>
		</Card>
	);
}

/** What each Workspace role can do. */
function RolesCard() {
	const t = useT();
	return (
		<Card size="sm">
			<CardHeader>
				<CardTitle>
					<h2>{t("members.rolesCard.heading")}</h2>
				</CardTitle>
			</CardHeader>
			<CardContent>
				<dl className="grid gap-3 text-sm">
					{(["owner", "editor", "author"] as const).map((role) => (
						<div key={role}>
							<dt className="font-medium">{t(`roles.${role}`)}</dt>
							<dd className="text-muted-foreground text-xs">{t(`members.rolesCard.${role}`)}</dd>
						</div>
					))}
				</dl>
			</CardContent>
		</Card>
	);
}
