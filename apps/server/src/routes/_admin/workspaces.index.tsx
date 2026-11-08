import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Avatar, AvatarFallback } from "@webcraft/ui/components/avatar.tsx";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { Building2Icon, PlusIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../../ui/api.ts";
import { errorMessage } from "../../ui/errors.ts";
import { formatUtcDate } from "../../ui/format.ts";
import { type MessageKey, pageTitle, useT } from "../../ui/i18n.tsx";
import { PageHeader } from "../../ui/PageHeader.tsx";
import { initials } from "../../ui/shell/context.ts";

export const Route = createFileRoute("/_admin/workspaces/")({
	staticData: { crumb: "workspaces.pageTitle" },
	loader: async () => {
		const api = await getApi();
		return api.workspaces.list();
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "workspaces.pageTitle") }] }),
	component: WorkspacesPage,
});

/** Install › Workspaces: every Workspace the person reaches; the Superadmin creates them here. */
function WorkspacesPage() {
	const t = useT();
	const { workspaces } = Route.useLoaderData();
	const { shell } = Route.useRouteContext();
	const canCreate = shell.permissions.includes("workspace.create");

	return (
		<>
			<PageHeader heading={t("workspaces.heading")} action={canCreate ? <NewWorkspaceDialog /> : undefined}>
				{canCreate ? t("workspaces.intro", { count: workspaces.length }) : t("workspaces.introStaff")}
			</PageHeader>
			{workspaces.length === 0 ? (
				<Empty className="border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Building2Icon aria-hidden="true" />
						</EmptyMedia>
						<EmptyTitle>
							<h2>{t("workspaces.empty.heading")}</h2>
						</EmptyTitle>
						<EmptyDescription>
							{canCreate ? t("workspaces.empty.body") : t("workspaces.emptyReach.body")}
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<div className="rounded-lg border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="ps-4">{t("workspaces.columns.name")}</TableHead>
								<TableHead>{t("workspaces.columns.sites")}</TableHead>
								<TableHead>{t("workspaces.columns.staff")}</TableHead>
								<TableHead className="pe-4">{t("workspaces.columns.created")}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{workspaces.map((workspace) => (
								<TableRow key={workspace.id}>
									<TableCell className="ps-4">
										<Link
											to="/workspaces/$workspaceId"
											params={{ workspaceId: workspace.id }}
											className="flex items-center gap-3 font-medium hover:underline"
										>
											<Avatar className="size-7 rounded-md">
												<AvatarFallback className="rounded-md text-xs">{initials(workspace.name)}</AvatarFallback>
											</Avatar>
											{workspace.name}
										</Link>
									</TableCell>
									<TableCell>{workspace.siteCount}</TableCell>
									<TableCell className="text-muted-foreground whitespace-normal">
										{workspace.staff.length > 0
											? workspace.staff.map((person) => person.name).join(", ")
											: t("workspaces.noStaff")}
									</TableCell>
									<TableCell className="text-muted-foreground pe-4">{formatUtcDate(workspace.createdAt)}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
		</>
	);
}

/** "New Workspace": asks for the client's name, then opens the new Workspace. */
function NewWorkspaceDialog() {
	const t = useT();
	const router = useRouter();
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!name.trim()) {
			setError("workspaces.dialog.nameRequired");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			const { workspace } = await api.workspaces.create({ name });
			toast.success(t("workspaces.created", { name: workspace.name }));
			setOpen(false);
			setName("");
			await router.invalidate();
			await navigate({ to: "/workspaces/$workspaceId", params: { workspaceId: workspace.id } });
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger render={<Button />}>
				<PlusIcon aria-hidden="true" />
				{t("workspaces.new")}
			</DialogTrigger>
			<DialogContent closeLabel={t("workspaces.dialog.close")} className="sm:max-w-md">
				<form onSubmit={submit} noValidate className="grid gap-4">
					<DialogHeader>
						<DialogTitle>{t("workspaces.dialog.title")}</DialogTitle>
						<DialogDescription>{t("workspaces.dialog.description")}</DialogDescription>
					</DialogHeader>
					<FieldGroup>
						<Field data-invalid={error ? true : undefined}>
							<FieldLabel htmlFor="workspace-name">{t("workspaces.dialog.name")}</FieldLabel>
							<Input
								id="workspace-name"
								value={name}
								maxLength={100}
								onChange={(event) => setName(event.target.value)}
								aria-invalid={error ? true : undefined}
								aria-describedby={error ? "workspace-name-help workspace-name-error" : "workspace-name-help"}
							/>
							<FieldDescription id="workspace-name-help">{t("workspaces.dialog.nameHelp")}</FieldDescription>
							{error ? <FieldError id="workspace-name-error">{t(error)}</FieldError> : null}
						</Field>
					</FieldGroup>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>
							{t("workspaces.dialog.cancel")}
						</DialogClose>
						<Button type="submit" disabled={busy}>
							{t("workspaces.dialog.create")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
