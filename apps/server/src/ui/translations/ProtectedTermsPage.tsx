import { useRouter } from "@tanstack/react-router";
import type { ProtectedTerm } from "@webcraft/core";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent } from "@webcraft/ui/components/card.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import { Field, FieldError, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { EllipsisIcon, InfoIcon, PlusIcon, SearchIcon, ShieldIcon, TrashIcon, UploadIcon } from "lucide-react";
import { type ChangeEvent, type FormEvent, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { PageHeader } from "../PageHeader.tsx";

/** A Site the person may give terms to. */
type SiteChoice = { id: string; name: string };

/**
 * Reads a CSV of terms: one term a line, optionally followed by a comma and `yes` or `no` for whether
 * case matters (yes when absent). A first line `term,match case` is a header.
 */
export function termsFromCsv(text: string): { term: string; matchCase: boolean }[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.map((line) => {
			const match = /^(.*?)(?:[,;\t]\s*(yes|no|true|false|1|0))?$/i.exec(line);
			const term = (match?.[1] ?? line).replace(/^"|"$/g, "").trim();
			const flag = (match?.[2] ?? "yes").toLowerCase();
			return { term, matchCase: flag === "yes" || flag === "true" || flag === "1" };
		})
		.filter((term, index) => !(index === 0 && /^term$/i.test(term.term)) && term.term !== "");
}

/**
 * Workspace › Protected terms: words AI translation leaves exactly as written in every language
 * (brand names, product names, people). The Workspace's apply to all its Sites; a Site can add its
 * own. Staff, Owners and Editors change them.
 */
export function ProtectedTermsPage({
	workspaceId,
	terms,
	sites,
	canEditWorkspace,
}: {
	workspaceId: string;
	terms: ProtectedTerm[];
	/** The Sites whose own terms the person may change. */
	sites: SiteChoice[];
	canEditWorkspace: boolean;
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const fileInput = useRef<HTMLInputElement>(null);
	const scopes = [...(canEditWorkspace ? [{ id: "", name: t("protectedTerms.wholeWorkspace") }] : []), ...sites];
	const [term, setTerm] = useState("");
	const [scope, setScope] = useState(scopes[0]?.id ?? "");
	const [matchCase, setMatchCase] = useState(true);
	const [error, setError] = useState<MessageKey | null>(null);
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<string | null>(null);
	const canEdit = scopes.length > 0;

	const add = async (list: { term: string; matchCase: boolean }[]) => {
		setError(null);
		try {
			const { added } = await (await getApi()).protectedTerms.add({ workspaceId, siteId: scope || null, terms: list });
			toast.success(t("protectedTerms.added", { count: added }));
			await router.invalidate();
			return true;
		} catch (failure) {
			setError(errorMessage(failure));
			return false;
		}
	};
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (await add([{ term, matchCase }])) setTerm("");
	};
	const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (!file) return;
		const list = termsFromCsv(await file.text());
		if (list.length === 0) {
			setError("protectedTerms.csvEmpty");
			return;
		}
		await add(list);
	};
	const remove = async (termId: string) => {
		try {
			await (await getApi()).protectedTerms.remove({ workspaceId, termId });
			toast.success(t("protectedTerms.removed"));
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};

	const counts = new Map<string, number>();
	for (const item of terms) counts.set(item.site?.id ?? "", (counts.get(item.site?.id ?? "") ?? 0) + 1);
	const tabs = [
		{ id: null, label: t("protectedTerms.filterAll", { count: terms.length }) },
		{ id: "", label: t("protectedTerms.filterWorkspace", { count: counts.get("") ?? 0 }) },
		...[...new Map(terms.filter((item) => item.site).map((item) => [item.site?.id ?? "", item.site?.name ?? ""]))].map(
			([siteId, name]) => ({
				id: siteId,
				label: t("protectedTerms.filterSite", { name, count: counts.get(siteId) ?? 0 }),
			}),
		),
	];
	const shown = terms
		.filter((item) => filter === null || (item.site?.id ?? "") === filter)
		.filter((item) => item.term.toLowerCase().includes(query.trim().toLowerCase()));

	return (
		<>
			<PageHeader
				heading={t("protectedTerms.heading")}
				action={
					canEdit ? (
						<>
							<Button variant="outline" onClick={() => fileInput.current?.click()}>
								<UploadIcon aria-hidden="true" />
								{t("protectedTerms.importCsv")}
							</Button>
							<input
								ref={fileInput}
								type="file"
								accept=".csv,text/csv,text/plain"
								className="sr-only"
								tabIndex={-1}
								aria-label={t("protectedTerms.importCsv")}
								onChange={(event) => void importFile(event)}
							/>
						</>
					) : null
				}
			>
				{t("protectedTerms.intro")}
			</PageHeader>
			<div className="grid max-w-6xl gap-6">
				{canEdit ? (
					<Card>
						<CardContent>
							<form onSubmit={submit} className="flex flex-wrap items-end gap-4" noValidate>
								<Field className="min-w-60 grow basis-80" data-invalid={error ? true : undefined}>
									<FieldLabel htmlFor={`${id}-term`}>{t("protectedTerms.term")}</FieldLabel>
									<Input
										id={`${id}-term`}
										value={term}
										maxLength={200}
										placeholder={t("protectedTerms.termPlaceholder")}
										onChange={(event) => setTerm(event.target.value)}
										aria-invalid={error ? true : undefined}
										aria-describedby={error ? `${id}-error` : undefined}
									/>
								</Field>
								<Field className="w-auto">
									<FieldLabel htmlFor={`${id}-scope`}>{t("protectedTerms.appliesTo")}</FieldLabel>
									<NativeSelect id={`${id}-scope`} value={scope} onChange={(event) => setScope(event.target.value)}>
										{scopes.map((choice) => (
											<NativeSelectOption key={choice.id} value={choice.id}>
												{choice.id ? t("protectedTerms.siteScope", { name: choice.name }) : choice.name}
											</NativeSelectOption>
										))}
									</NativeSelect>
								</Field>
								<Field orientation="horizontal" className="w-auto pb-2">
									<Checkbox
										id={`${id}-case`}
										checked={matchCase}
										onCheckedChange={(checked) => setMatchCase(checked === true)}
									/>
									<FieldLabel htmlFor={`${id}-case`}>{t("protectedTerms.matchCase")}</FieldLabel>
								</Field>
								<Button type="submit" disabled={term.trim() === ""}>
									<PlusIcon aria-hidden="true" />
									{t("protectedTerms.add")}
								</Button>
								{error ? (
									<FieldError id={`${id}-error`} className="basis-full">
										{t(error)}
									</FieldError>
								) : null}
							</form>
						</CardContent>
					</Card>
				) : null}

				<div className="flex flex-wrap items-center gap-3">
					<div className="relative w-full max-w-sm">
						<SearchIcon
							className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
							aria-hidden="true"
						/>
						<Input
							type="search"
							value={query}
							aria-label={t("protectedTerms.search", { count: terms.length })}
							placeholder={t("protectedTerms.search", { count: terms.length })}
							className="ps-9"
							onChange={(event) => setQuery(event.target.value)}
						/>
					</div>
					<fieldset className="bg-muted flex flex-wrap gap-1 rounded-lg p-1">
						<legend className="sr-only">{t("protectedTerms.filter")}</legend>
						{tabs.map((tab) => (
							<Button
								key={tab.id ?? "all"}
								size="sm"
								variant={filter === tab.id ? "outline" : "ghost"}
								aria-pressed={filter === tab.id}
								onClick={() => setFilter(tab.id)}
							>
								{tab.label}
							</Button>
						))}
					</fieldset>
				</div>

				<Card>
					<CardContent>
						{shown.length === 0 ? (
							<p className="text-muted-foreground text-sm">{t("protectedTerms.empty")}</p>
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>{t("protectedTerms.term")}</TableHead>
										<TableHead>{t("protectedTerms.appliesTo")}</TableHead>
										<TableHead>{t("protectedTerms.matchCase")}</TableHead>
										<TableHead>{t("protectedTerms.addedBy")}</TableHead>
										{canEdit ? (
											<TableHead>
												<span className="sr-only">{t("protectedTerms.actions")}</span>
											</TableHead>
										) : null}
									</TableRow>
								</TableHeader>
								<TableBody>
									{shown.map((item) => {
										const removable = item.site ? sites.some((site) => site.id === item.site?.id) : canEditWorkspace;
										return (
											<TableRow key={item.id}>
												<TableCell className="font-medium">
													<span className="flex items-center gap-2">
														<ShieldIcon className="text-muted-foreground size-4" aria-hidden="true" />
														{item.term}
													</span>
												</TableCell>
												<TableCell>
													<Badge variant="outline">
														{item.site
															? t("protectedTerms.siteScope", { name: item.site.name })
															: t("protectedTerms.workspace")}
													</Badge>
												</TableCell>
												<TableCell>{item.matchCase ? t("protectedTerms.yes") : t("protectedTerms.no")}</TableCell>
												<TableCell>{item.addedBy?.name ?? "—"}</TableCell>
												{canEdit ? (
													<TableCell className="text-end">
														{removable ? (
															<DropdownMenu>
																<DropdownMenuTrigger
																	render={
																		<Button
																			variant="ghost"
																			size="icon-sm"
																			aria-label={t("protectedTerms.menu", { term: item.term })}
																		/>
																	}
																>
																	<EllipsisIcon aria-hidden="true" />
																</DropdownMenuTrigger>
																<DropdownMenuContent align="end">
																	<DropdownMenuItem onClick={() => void remove(item.id)}>
																		<TrashIcon aria-hidden="true" />
																		{t("protectedTerms.remove")}
																	</DropdownMenuItem>
																</DropdownMenuContent>
															</DropdownMenu>
														) : null}
													</TableCell>
												) : null}
											</TableRow>
										);
									})}
								</TableBody>
							</Table>
						)}
					</CardContent>
				</Card>

				<p className="flex items-start gap-3 rounded-lg border border-sky-300 bg-sky-50 px-4 py-3 text-sm text-sky-950 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100">
					<InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
					{t("protectedTerms.note")}
				</p>
			</div>
		</>
	);
}
