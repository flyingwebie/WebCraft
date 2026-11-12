import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Button, buttonVariants } from "@webcraft/ui/components/button.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { ComponentIcon, PlusIcon } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { getApi } from "../../ui/api.ts";
import { BuilderNavigation } from "../../ui/builder/BuilderNavigation.tsx";
import { StatusBadge } from "../../ui/content/DraftParts.tsx";
import { errorMessage } from "../../ui/errors.ts";
import { HistoryLink } from "../../ui/history/HistoryLink.tsx";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";

/**
 * Site › Components (Structure, Staff only): the Site's Components (and those of the Modules running
 * on it), where each is used, and a new one, each of the Site's own opened in the visual builder.
 */
export const Route = createFileRoute("/_admin/sites/$siteId/components")({
	staticData: { crumb: "components.pageTitle" },
	loader: async ({ context, params }) => {
		if (!context.place.permissions.includes("structure.edit")) return { components: null };
		const api = await getApi();
		return { components: (await api.components.list({ siteId: params.siteId })).components };
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "components.pageTitle") }] }),
	component: ComponentsPage,
});

function ComponentsPage() {
	const t = useT();
	const { components } = Route.useLoaderData();
	const { siteId } = Route.useParams();
	if (!components) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<>
			<PageHeader heading={t("components.pageTitle")} action={<NewComponentDialog siteId={siteId} />}>
				{t("components.intro")}
			</PageHeader>
			{components.length === 0 ? (
				<p className="text-muted-foreground">{t("components.none")}</p>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>{t("components.columns.name")}</TableHead>
							<TableHead>{t("components.columns.status")}</TableHead>
							<TableHead>{t("components.columns.usage")}</TableHead>
							<TableHead>
								<span className="sr-only">{t("components.columns.open")}</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{components.map((component) => (
							<TableRow key={component.id}>
								<TableCell>
									<span className="flex items-center gap-2 font-mono font-medium">
										<ComponentIcon className="text-muted-foreground size-4" aria-hidden="true" />
										{component.name}
									</span>
								</TableCell>
								<TableCell>
									{component.module ? (
										<span className="text-muted-foreground">
											{t("components.fromModule", { module: component.module.id })}
										</span>
									) : (
										<StatusBadge status={component.status} />
									)}
								</TableCell>
								<TableCell>{t("components.pages", { count: component.usage.pages })}</TableCell>
								<TableCell className="text-end">
									{component.module ? null : (
										<span className="inline-flex flex-wrap justify-end gap-2">
											<BuilderNavigation
												siteId={siteId}
												target={{ kind: "component", componentId: component.id }}
												list
											/>
											<HistoryLink
												siteId={siteId}
												item={{ kind: "component", id: component.id }}
												name={component.name}
												size="sm"
											/>
											<Link
												to="/builder/$siteId/$"
												params={{ siteId, _splat: `component/${component.id}` }}
												className={buttonVariants({ variant: "outline", size: "sm" })}
											>
												{t("templates.open")}
												<span className="sr-only">{t("templates.openNamed", { name: component.name })}</span>
											</Link>
										</span>
									)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</>
	);
}

/** Creates a Component from its name (its PascalCase tag in Template markup), then opens it in the builder. */
function NewComponentDialog({ siteId }: { siteId: string }) {
	const t = useT();
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!name.trim()) {
			setError(t("components.create.nameRequired"));
			return;
		}
		setBusy(true);
		try {
			const api = await getApi();
			const { component } = await api.components.create({ siteId, name: name.trim() });
			setOpen(false);
			await navigate({ to: "/builder/$siteId/$", params: { siteId, _splat: `component/${component.id}` } });
		} catch (failure) {
			const problems = (failure as { data?: { problems?: { message: string }[] } }).data?.problems;
			setError(problems?.length ? problems.map((problem) => problem.message).join(" ") : t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<Button ref={trigger} type="button" onClick={() => setOpen(true)}>
				<PlusIcon aria-hidden="true" />
				{t("components.create.open")}
			</Button>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					setOpen(next);
					if (!next) setError(null);
				}}
			>
				<DialogContent closeLabel={t("components.create.close")} finalFocus={trigger}>
					<form onSubmit={submit} className="grid gap-6" noValidate>
						<DialogHeader>
							<DialogTitle>{t("components.create.title")}</DialogTitle>
							<DialogDescription>{t("components.create.intro")}</DialogDescription>
						</DialogHeader>
						<Field data-invalid={error ? true : undefined}>
							<FieldLabel htmlFor="new-component-name">{t("components.create.name")}</FieldLabel>
							<Input
								id="new-component-name"
								value={name}
								onChange={(event) => setName(event.target.value)}
								autoComplete="off"
								spellCheck={false}
								className="font-mono"
								aria-invalid={error ? true : undefined}
								aria-describedby={["new-component-name-help", error ? "new-component-name-error" : null]
									.filter(Boolean)
									.join(" ")}
							/>
							<FieldDescription id="new-component-name-help">{t("components.create.nameHelp")}</FieldDescription>
							{error ? <FieldError id="new-component-name-error">{error}</FieldError> : null}
						</Field>
						<DialogFooter>
							<DialogClose render={<Button variant="outline" type="button" />}>
								{t("components.create.cancel")}
							</DialogClose>
							<Button type="submit" disabled={busy}>
								{t("components.create.submit")}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
