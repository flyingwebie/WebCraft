import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { EllipsisIcon, PlusIcon, TrashIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../../ui/api.ts";
import { errorMessage } from "../../ui/errors.ts";
import { CaptchaCard } from "../../ui/forms/CaptchaCard.tsx";
import { problemsOf } from "../../ui/forms/model.ts";
import { StatusBadge } from "../../ui/forms/StatusBadge.tsx";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";

export const Route = createFileRoute("/_admin/sites/$siteId/forms/")({
	staticData: { crumb: "forms.pageTitle" },
	loader: async ({ context, params }) => {
		if (!context.place.permissions.includes("structure.edit")) return null;
		const api = await getApi();
		const [{ forms }, captcha] = await Promise.all([
			api.forms.list({ siteId: params.siteId }),
			api.forms.captcha.get({ siteId: params.siteId }),
		]);
		return { forms, captcha };
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "forms.pageTitle") }] }),
	component: FormsPage,
});

/**
 * Site › Forms (Structure, Staff only): the Site's Forms, each with its key (`{{@form <key>}}`), its
 * status and where it is placed; a new Form; deleting one that nothing places; and the Site's
 * CAPTCHA, which every Form of the Site shows once it is set up.
 */
function FormsPage() {
	const t = useT();
	const data = Route.useLoaderData();
	const { siteId } = Route.useParams();
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<>
			<PageHeader heading={t("forms.heading")} action={<NewFormDialog siteId={siteId} />}>
				{t("forms.intro")}
			</PageHeader>
			<div className="grid max-w-4xl gap-8">
				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("forms.listTitle")}</h2>
						</CardTitle>
						<CardDescription>{t("forms.listIntro")}</CardDescription>
					</CardHeader>
					<CardContent>
						{data.forms.length === 0 ? (
							<p className="text-muted-foreground text-sm">{t("forms.none")}</p>
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>{t("forms.name")}</TableHead>
										<TableHead>{t("forms.key")}</TableHead>
										<TableHead>{t("forms.status")}</TableHead>
										<TableHead>{t("forms.placed")}</TableHead>
										<TableHead>
											<span className="sr-only">{t("forms.actions")}</span>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.forms.map((form) => (
										<TableRow key={form.id}>
											<TableCell>
												<Link
													to="/sites/$siteId/forms/$formId"
													params={{ siteId, formId: form.id }}
													className="font-medium underline-offset-4 hover:underline"
												>
													{form.name}
												</Link>
											</TableCell>
											<TableCell className="font-mono text-sm">{`{{@form ${form.key}}}`}</TableCell>
											<TableCell>
												<StatusBadge status={form.status} />
											</TableCell>
											<TableCell className="text-sm">
												{t("forms.placedCount", { count: form.usage.usedIn.length })}
											</TableCell>
											<TableCell className="text-end">
												<FormActions siteId={siteId} form={form} />
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						)}
					</CardContent>
				</Card>
				<CaptchaCard siteId={siteId} view={data.captcha} />
			</div>
		</>
	);
}

/** Creates a Form from its name (and, optionally, its key), then opens it. */
function NewFormDialog({ siteId }: { siteId: string }) {
	const t = useT();
	const navigate = useNavigate();
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [key, setKey] = useState("");
	const [problem, setProblem] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const create = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setProblem(null);
		try {
			const api = await getApi();
			const { form } = await api.forms.create({ siteId, name, key: key.trim() === "" ? undefined : key.trim() });
			setOpen(false);
			await router.invalidate();
			await navigate({ to: "/sites/$siteId/forms/$formId", params: { siteId, formId: form.id } });
		} catch (error) {
			const [first] = problemsOf(error);
			setProblem(first ? first.message : t(errorMessage(error)));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<Button onClick={() => setOpen(true)}>
				<PlusIcon data-icon="inline-start" />
				{t("forms.new")}
			</Button>
			<DialogContent>
				<form onSubmit={create} className="grid gap-4">
					<DialogHeader>
						<DialogTitle>{t("forms.newTitle")}</DialogTitle>
						<DialogDescription>{t("forms.newIntro")}</DialogDescription>
					</DialogHeader>
					<FieldGroup>
						<Field>
							<FieldLabel htmlFor="new-form-name">{t("forms.name")}</FieldLabel>
							<Input id="new-form-name" value={name} onChange={(event) => setName(event.target.value)} required />
						</Field>
						<Field>
							<FieldLabel htmlFor="new-form-key">{t("forms.keyOptional")}</FieldLabel>
							<Input
								id="new-form-key"
								value={key}
								onChange={(event) => setKey(event.target.value)}
								aria-describedby="new-form-key-help"
							/>
							<FieldDescription id="new-form-key-help">{t("forms.keyHelp")}</FieldDescription>
						</Field>
						{problem ? <FieldError>{problem}</FieldError> : null}
					</FieldGroup>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("forms.cancel")}</DialogClose>
						<Button type="submit" disabled={busy}>
							{t("forms.create")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** A Form's menu: delete it, in two steps (asked, then confirmed), refused while something places it. */
function FormActions({ siteId, form }: { siteId: string; form: { id: string; name: string } }) {
	const t = useT();
	const router = useRouter();
	const [confirmation, setConfirmation] = useState<string | null>(null);
	const failed = (error: unknown) =>
		toast.error(
			(error as { code?: unknown }).code === "FORM_IN_USE" ? t("errors.FORM_IN_USE") : t(errorMessage(error)),
		);
	const ask = async () => {
		try {
			const api = await getApi();
			const first = await api.forms.delete({ siteId, formId: form.id });
			if (!first.deleted) setConfirmation(first.confirmation.id);
		} catch (error) {
			failed(error);
		}
	};
	const confirm = async () => {
		if (!confirmation) return;
		try {
			const api = await getApi();
			await api.forms.delete({ siteId, formId: form.id, confirmation });
			setConfirmation(null);
			toast.success(t("forms.deleted", { name: form.name }));
			await router.invalidate();
		} catch (error) {
			setConfirmation(null);
			failed(error);
		}
	};
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={<Button variant="ghost" size="icon" aria-label={t("forms.actionsOf", { name: form.name })} />}
				>
					<EllipsisIcon />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem variant="destructive" onClick={ask}>
						<TrashIcon />
						{t("forms.delete")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<Dialog open={confirmation !== null} onOpenChange={(open) => (open ? null : setConfirmation(null))}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t("forms.deleteTitle", { name: form.name })}</DialogTitle>
						<DialogDescription>{t("forms.deleteBody")}</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("forms.cancel")}</DialogClose>
						<Button variant="destructive" onClick={confirm}>
							{t("forms.delete")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
