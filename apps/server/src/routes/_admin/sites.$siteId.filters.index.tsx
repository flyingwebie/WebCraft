import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { cn } from "@webcraft/ui/lib/utils.ts";
import { PlusIcon } from "lucide-react";
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";

import { cellClass, headClass, headRowClass, TableFrame } from "../../ui/analytics/parts.tsx";
import { getApi } from "../../ui/api.ts";
import { errorMessage } from "../../ui/errors.ts";
import { FilterStatus } from "../../ui/filters/FilterStatus.tsx";
import { problemsOf } from "../../ui/filters/model.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";
import { PageSheet } from "../../ui/shell/page.tsx";

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
 * Site › Filters (Structure, Staff only): the Site's Filters as a list, as Site › Goals: each with the
 * query Loop it narrows, its markup (`{{@filter <name> for="<loop>"}}`), its status and where it is
 * placed; and New Filter, in a sheet, for a query Loop that has none.
 */
function FiltersPage() {
	const t = useT();
	const data = Route.useLoaderData();
	const { siteId } = Route.useParams();
	const newButton = useRef<HTMLButtonElement>(null);
	const [creating, setCreating] = useState(false);
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<>
			<PageHeader
				heading={t("filters.heading")}
				action={
					<Button ref={newButton} onClick={() => setCreating(true)}>
						<PlusIcon data-icon="inline-start" />
						{t("filters.new")}
					</Button>
				}
			>
				{t("filters.intro")}
			</PageHeader>
			<TableFrame>
				<Table aria-label={t("filters.heading")} className="min-w-180 table-fixed">
					<colgroup>
						<col className="w-[20%]" />
						<col className="w-[16%]" />
						<col />
						<col className="w-40" />
						<col className="w-36" />
					</colgroup>
					<TableHeader>
						<TableRow className={headRowClass}>
							<TableHead scope="col" className={headClass}>
								{t("filters.name")}
							</TableHead>
							<TableHead scope="col" className={headClass}>
								{t("filters.loop")}
							</TableHead>
							<TableHead scope="col" className={headClass}>
								{t("filters.markup")}
							</TableHead>
							<TableHead scope="col" className={headClass}>
								{t("filters.status")}
							</TableHead>
							<TableHead scope="col" className={headClass}>
								{t("filters.placed")}
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{data.filters.length === 0 ? (
							<TableRow className="hover:bg-transparent">
								<TableCell colSpan={5} className="text-muted-foreground px-4 py-8 text-center whitespace-normal">
									{t("filters.none")}
								</TableCell>
							</TableRow>
						) : (
							data.filters.map((filter) => {
								const markup = `{{@filter ${filter.name} for="${filter.loop}"}}`;
								return (
									<TableRow key={filter.id}>
										<TableCell className={cn(cellClass, "truncate")}>
											<Link
												to="/sites/$siteId/filters/$filterId"
												params={{ siteId, filterId: filter.id }}
												className="font-medium underline-offset-4 hover:underline"
											>
												{filter.name}
											</Link>
										</TableCell>
										<TableCell className={cn(cellClass, "text-muted-foreground truncate font-mono text-[13px]")}>
											{filter.loop}
										</TableCell>
										<TableCell className={cn(cellClass, "truncate font-mono text-[13px]")} title={markup}>
											{markup}
										</TableCell>
										<TableCell className={cellClass}>
											<FilterStatus status={filter.status} />
										</TableCell>
										<TableCell className={cn(cellClass, "text-muted-foreground truncate")}>
											{t("filters.placedCount", { count: filter.usage.usedIn.length })}
										</TableCell>
									</TableRow>
								);
							})
						)}
					</TableBody>
				</Table>
			</TableFrame>
			{creating ? (
				<NewFilterSheet siteId={siteId} loops={data.free} finalFocus={newButton} onClose={() => setCreating(false)} />
			) : null}
		</>
	);
}

/** Creates a Filter from its name and the query Loop it narrows (neither changes later), then opens it. */
function NewFilterSheet({
	siteId,
	loops,
	finalFocus,
	onClose,
}: {
	siteId: string;
	loops: readonly string[];
	finalFocus: RefObject<HTMLElement | null>;
	onClose: () => void;
}) {
	const t = useT();
	const navigate = useNavigate();
	const router = useRouter();
	const id = useId();
	const [name, setName] = useState("");
	const [loop, setLoop] = useState(loops[0] ?? "");
	const [problem, setProblem] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const create = async (event: FormEvent) => {
		event.preventDefault();
		if (loops.length === 0) return;
		setBusy(true);
		setProblem(null);
		try {
			const api = await getApi();
			const { filter } = await api.filters.create({ siteId, name: name.trim(), loop });
			onClose();
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
		<PageSheet
			open
			onOpenChange={(open) => !open && onClose()}
			title={t("filters.newTitle")}
			description={t("filters.newIntro")}
			finalFocus={finalFocus}
			className="data-[side=right]:sm:max-w-95"
			footer={
				<>
					<Button type="button" variant="outline" onClick={onClose}>
						{t("filters.cancel")}
					</Button>
					<Button type="submit" form={`${id}-form`} disabled={busy || loops.length === 0}>
						{t("filters.create")}
					</Button>
				</>
			}
		>
			<form id={`${id}-form`} onSubmit={create} noValidate>
				<FieldGroup className="gap-5">
					<Field>
						<FieldLabel htmlFor={`${id}-name`}>{t("filters.name")}</FieldLabel>
						<Input
							id={`${id}-name`}
							value={name}
							onChange={(event) => setName(event.target.value)}
							className="font-mono"
							spellCheck={false}
							autoComplete="off"
							aria-describedby={`${id}-name-help`}
							required
						/>
						<FieldDescription id={`${id}-name-help`}>{t("filters.nameHelp")}</FieldDescription>
					</Field>
					<Field>
						<FieldLabel htmlFor={`${id}-loop`}>{t("filters.loop")}</FieldLabel>
						<NativeSelect
							id={`${id}-loop`}
							value={loop}
							onChange={(event) => setLoop(event.target.value)}
							aria-describedby={`${id}-loop-help`}
						>
							{loops.length === 0 ? <NativeSelectOption value="">{t("filters.noLoops")}</NativeSelectOption> : null}
							{loops.map((each) => (
								<NativeSelectOption key={each} value={each}>
									{each}
								</NativeSelectOption>
							))}
						</NativeSelect>
						<FieldDescription id={`${id}-loop-help`}>{t("filters.loopHelp")}</FieldDescription>
					</Field>
					{problem ? <FieldError>{problem}</FieldError> : null}
				</FieldGroup>
			</form>
		</PageSheet>
	);
}
