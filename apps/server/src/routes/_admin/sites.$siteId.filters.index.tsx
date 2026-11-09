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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { PlusIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

import { getApi } from "../../ui/api.ts";
import { errorMessage } from "../../ui/errors.ts";
import { problemsOf } from "../../ui/filters/model.ts";
import { StatusBadge } from "../../ui/forms/StatusBadge.tsx";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";

export const Route = createFileRoute("/_admin/sites/$siteId/filters/")({
	staticData: { crumb: "filters.pageTitle" },
	loader: async ({ context, params }) => {
		if (!context.place.permissions.includes("structure.edit")) return null;
		const api = await getApi();
		const [{ filters }, { loops }] = await Promise.all([
			api.filters.list({ siteId: params.siteId }),
			api.loops.list({ siteId: params.siteId }),
		]);
		// A Filter narrows a query Loop, one Filter each: the Loops a new Filter can narrow.
		const taken = new Set(filters.map((filter) => filter.loop));
		const free = loops
			.filter((loop) => loop.draft.source === "query" && !taken.has(loop.name))
			.map((loop) => loop.name);
		return { filters, free };
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "filters.pageTitle") }] }),
	component: FiltersPage,
});

/**
 * Site › Filters (Structure, Staff only): the Site's Filters, each with the query Loop it narrows, its
 * markup (`{{@filter <name> for="<loop>"}}`), its status and where it is placed; and a new Filter for a
 * query Loop that has none.
 */
function FiltersPage() {
	const t = useT();
	const data = Route.useLoaderData();
	const { siteId } = Route.useParams();
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<>
			<PageHeader heading={t("filters.heading")} action={<NewFilterDialog siteId={siteId} loops={data.free} />}>
				{t("filters.intro")}
			</PageHeader>
			<div className="grid max-w-4xl gap-8">
				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("filters.listTitle")}</h2>
						</CardTitle>
						<CardDescription>{t("filters.listIntro")}</CardDescription>
					</CardHeader>
					<CardContent>
						{data.filters.length === 0 ? (
							<p className="text-muted-foreground text-sm">{t("filters.none")}</p>
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>{t("filters.name")}</TableHead>
										<TableHead>{t("filters.markup")}</TableHead>
										<TableHead>{t("filters.status")}</TableHead>
										<TableHead>{t("filters.placed")}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.filters.map((filter) => (
										<TableRow key={filter.id}>
											<TableCell>
												<Link
													to="/sites/$siteId/filters/$filterId"
													params={{ siteId, filterId: filter.id }}
													className="font-medium underline-offset-4 hover:underline"
												>
													{filter.name}
												</Link>
											</TableCell>
											<TableCell className="font-mono text-sm">{`{{@filter ${filter.name} for="${filter.loop}"}}`}</TableCell>
											<TableCell>
												<StatusBadge status={filter.status} />
											</TableCell>
											<TableCell className="text-sm">
												{t("filters.placedCount", { count: filter.usage.usedIn.length })}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						)}
					</CardContent>
				</Card>
			</div>
		</>
	);
}

/** Creates a Filter from its name and the query Loop it narrows (neither changes later), then opens it. */
function NewFilterDialog({ siteId, loops }: { siteId: string; loops: readonly string[] }) {
	const t = useT();
	const navigate = useNavigate();
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [loop, setLoop] = useState(loops[0] ?? "");
	const [problem, setProblem] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const create = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setProblem(null);
		try {
			const api = await getApi();
			const { filter } = await api.filters.create({ siteId, name: name.trim(), loop });
			setOpen(false);
			await router.invalidate();
			await navigate({ to: "/sites/$siteId/filters/$filterId", params: { siteId, filterId: filter.id } });
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
				{t("filters.new")}
			</Button>
			<DialogContent>
				<form onSubmit={create} className="grid gap-4">
					<DialogHeader>
						<DialogTitle>{t("filters.newTitle")}</DialogTitle>
						<DialogDescription>{t("filters.newIntro")}</DialogDescription>
					</DialogHeader>
					<FieldGroup>
						<Field>
							<FieldLabel htmlFor="new-filter-name">{t("filters.name")}</FieldLabel>
							<Input
								id="new-filter-name"
								value={name}
								onChange={(event) => setName(event.target.value)}
								className="font-mono"
								spellCheck={false}
								autoComplete="off"
								aria-describedby="new-filter-name-help"
								required
							/>
							<FieldDescription id="new-filter-name-help">{t("filters.nameHelp")}</FieldDescription>
						</Field>
						<Field>
							<FieldLabel htmlFor="new-filter-loop">{t("filters.loop")}</FieldLabel>
							<NativeSelect
								id="new-filter-loop"
								value={loop}
								onChange={(event) => setLoop(event.target.value)}
								aria-describedby="new-filter-loop-help"
							>
								{loops.length === 0 ? <NativeSelectOption value="">{t("filters.noLoops")}</NativeSelectOption> : null}
								{loops.map((each) => (
									<NativeSelectOption key={each} value={each}>
										{each}
									</NativeSelectOption>
								))}
							</NativeSelect>
							<FieldDescription id="new-filter-loop-help">{t("filters.loopHelp")}</FieldDescription>
						</Field>
						{problem ? <FieldError>{problem}</FieldError> : null}
					</FieldGroup>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("filters.cancel")}</DialogClose>
						<Button type="submit" disabled={busy || loops.length === 0}>
							{t("filters.create")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
