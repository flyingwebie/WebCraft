import type { ApiClient } from "@webcraft/api";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@webcraft/ui/components/empty.tsx";
import { Field, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { DownloadIcon, ScrollTextIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { downloadCsv } from "../dashboards/model.ts";
import { errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { adminMessages, type MessageKey, useT } from "../i18n.tsx";

/** One page of the Audit log, as `audit.list` and `me.activity` answer it. */
export type AuditPage = Awaited<ReturnType<ApiClient["me"]["activity"]>>;
type AuditEntry = AuditPage["entries"][number];
type Via = AuditEntry["via"];

/** The ways an action comes in, as the "How" filter offers them. */
const VIA_KINDS = [
	"admin",
	"editMode",
	"token",
	"aiClient",
	"impersonation",
	"module",
	"command",
	"translation",
	"scheduledPublish",
] as const satisfies readonly Via["kind"][];

/** The names a page knows, kept across pages: people, Workspaces and Sites by id. */
type Names = Pick<AuditPage, "people" | "workspaces" | "sites">;

/** How the admin words entries: what was done, who did it, how it came in and where. */
export function useAuditWords() {
	const t = useT();
	return useMemo(
		() => ({
			/** An action in words; a Module's own as "<module>: <action>". */
			action(name: string): string {
				const key = `audit.actions.${name}` as MessageKey;
				if (t.has(key)) return t(key);
				const [module, ...rest] = name.split(".");
				return rest.length > 0 ? t("audit.moduleAction", { module: module ?? "", action: rest.join(".") }) : name;
			},
			/** Who acted: a person, "<person> via <client>", "<Staff> as <Member>", or WebCraft itself. */
			who(entry: AuditEntry, names: Names): string {
				if (!entry.personId)
					return entry.via.kind === "module"
						? t("audit.howWords.module", { name: entry.via.name })
						: t("audit.whoWords.webcraft");
				const person = names.people[entry.personId]?.name ?? t("audit.whoWords.gone");
				if (entry.via.kind === "impersonation") {
					return t("audit.whoWords.as", { impersonator: entry.via.name, person });
				}
				if (entry.via.kind === "token" || entry.via.kind === "aiClient") {
					return t("audit.whoWords.via", { person, client: entry.via.name });
				}
				return person;
			},
			/** How it came in. */
			how(via: Via): string {
				return t(`audit.howWords.${via.kind}`, { name: "name" in via ? via.name : "" });
			},
			/** Where: the Workspace (or the Install) and the Site. */
			where(entry: AuditEntry, names: Names): string {
				const workspace = entry.workspaceId
					? (names.workspaces[entry.workspaceId] ?? t("audit.workspaceGone"))
					: t("audit.install");
				if (!entry.siteId) return workspace;
				return `${workspace} › ${names.sites[entry.siteId] ?? t("audit.siteGone")}`;
			},
		}),
		[t],
	);
}

type ActionMessages = { [name: string]: string | ActionMessages };

/** Leaf messages name actions, including nested ones such as import.credentials.use. */
function actionNames(messages: ActionMessages, prefix = ""): string[] {
	return Object.entries(messages).flatMap(([name, value]) => {
		const path = prefix ? `${prefix}.${name}` : name;
		return typeof value === "string" ? [path] : actionNames(value, path);
	});
}

/** Every action the admin has words for, sorted by them, for the "What" filter. */
function useActionChoices(): { value: string; label: string }[] {
	const words = useAuditWords();
	return useMemo(() => {
		// Every language words the same actions: their names come from the English file.
		return actionNames(adminMessages.en.audit.actions)
			.map((value) => ({ value, label: words.action(value) }))
			.sort((a, b) => a.label.localeCompare(b.label));
	}, [words]);
}

/** The filters a level's Audit log offers. Dates are days in UTC; "until" includes its day. */
type Filters = {
	personId: string;
	action: string;
	via: string;
	workspaceId: string;
	siteId: string;
	from: string;
	until: string;
};

const NO_FILTERS: Filters = { personId: "", action: "", via: "", workspaceId: "", siteId: "", from: "", until: "" };

/** The filters as `audit.list` takes them. */
function queryOf(filters: Filters, workspaceId: string | undefined) {
	const day = 24 * 60 * 60 * 1000;
	const workspace = workspaceId ?? (filters.workspaceId || undefined);
	return {
		...(workspace ? { workspaceId: workspace } : {}),
		...(filters.personId ? { personId: filters.personId } : {}),
		...(filters.action ? { action: filters.action } : {}),
		...(filters.via ? { via: filters.via as Via["kind"] } : {}),
		...(filters.siteId ? { siteId: filters.siteId } : {}),
		...(filters.from ? { from: new Date(`${filters.from}T00:00:00Z`) } : {}),
		...(filters.until ? { to: new Date(new Date(`${filters.until}T00:00:00Z`).getTime() + day) } : {}),
	};
}

/**
 * A level's Audit log: the Install's (the Superadmin) or one Workspace's (Staff and Owners), with
 * its filters (who, what, how, the Workspace or Site, dates), pages of older entries and the CSV
 * export. Nothing here changes an entry: none can be changed.
 */
export function AuditLogScreen({
	workspaceId,
	first,
	people,
	workspaces,
	sites,
}: {
	/** One Workspace's log; the whole Install's without it. */
	workspaceId?: string;
	first: AuditPage;
	people: readonly { id: string; name: string; email: string }[];
	/** The Workspaces to filter by (the Install's log). */
	workspaces?: readonly { id: string; name: string }[];
	/** The Sites to filter by (a Workspace's log). */
	sites?: readonly { id: string; name: string }[];
}) {
	const t = useT();
	const ids = useId();
	const actions = useActionChoices();
	const [filters, setFilters] = useState<Filters>(NO_FILTERS);
	const [page, setPage] = useState<{ entries: AuditEntry[]; next: string | null; names: Names }>({
		entries: first.entries,
		next: first.next,
		names: first,
	});
	const [busy, setBusy] = useState(false);
	const loaded = useRef(false);

	// A change of filters reads the first page again.
	useEffect(() => {
		if (!loaded.current) {
			loaded.current = true;
			return;
		}
		let current = true;
		setBusy(true);
		void (async () => {
			try {
				const api = await getApi();
				const read = await api.audit.list(queryOf(filters, workspaceId));
				if (current) setPage({ entries: read.entries, next: read.next, names: read });
			} catch (failure) {
				if (current) toast.error(t(errorMessage(failure)));
			} finally {
				if (current) setBusy(false);
			}
		})();
		return () => {
			current = false;
		};
	}, [filters, workspaceId, t]);

	const showOlder = async () => {
		if (!page.next) return;
		setBusy(true);
		try {
			const api = await getApi();
			const read = await api.audit.list({ ...queryOf(filters, workspaceId), after: page.next });
			setPage((current) => ({
				entries: [...current.entries, ...read.entries],
				next: read.next,
				names: mergeNames(current.names, read),
			}));
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};

	const exportCsv = async () => {
		try {
			const api = await getApi();
			const file = await api.audit.export(queryOf(filters, workspaceId));
			downloadCsv(file);
			toast.success(
				file.truncated
					? t("audit.exportedTruncated", { count: 50_000, filename: file.filename })
					: t("audit.exported", { filename: file.filename }),
			);
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};

	const set = (key: keyof Filters) => (value: string) => setFilters((current) => ({ ...current, [key]: value }));
	const filtered = Object.values(filters).some((value) => value !== "");

	return (
		<div className="flex flex-col gap-4">
			<section aria-labelledby={`${ids}-filters`} className="flex flex-wrap items-end gap-3">
				<h2 id={`${ids}-filters`} className="sr-only">
					{t("audit.filtersLabel")}
				</h2>
				<FilterSelect
					id={`${ids}-who`}
					label={t("audit.who")}
					value={filters.personId}
					onChange={set("personId")}
					any={t("audit.everyone")}
					options={people.map((person) => ({ value: person.id, label: `${person.name} (${person.email})` }))}
				/>
				<FilterSelect
					id={`${ids}-action`}
					label={t("audit.action")}
					value={filters.action}
					onChange={set("action")}
					any={t("audit.everyAction")}
					options={actions}
				/>
				<FilterSelect
					id={`${ids}-how`}
					label={t("audit.how")}
					value={filters.via}
					onChange={set("via")}
					any={t("audit.everyWay")}
					options={VIA_KINDS.map((kind) => ({ value: kind, label: t(`audit.howOptions.${kind}`) }))}
				/>
				{workspaces ? (
					<FilterSelect
						id={`${ids}-workspace`}
						label={t("audit.workspace")}
						value={filters.workspaceId}
						onChange={set("workspaceId")}
						any={t("audit.everyWorkspace")}
						options={workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }))}
					/>
				) : null}
				{sites && sites.length > 0 ? (
					<FilterSelect
						id={`${ids}-site`}
						label={t("audit.site")}
						value={filters.siteId}
						onChange={set("siteId")}
						any={t("audit.everySite")}
						options={sites.map((site) => ({ value: site.id, label: site.name }))}
					/>
				) : null}
				<Field className="w-40">
					<FieldLabel htmlFor={`${ids}-from`}>{t("audit.from")}</FieldLabel>
					<Input
						id={`${ids}-from`}
						type="date"
						value={filters.from}
						onChange={(event) => set("from")(event.target.value)}
					/>
				</Field>
				<Field className="w-40">
					<FieldLabel htmlFor={`${ids}-until`}>{t("audit.until")}</FieldLabel>
					<Input
						id={`${ids}-until`}
						type="date"
						value={filters.until}
						onChange={(event) => set("until")(event.target.value)}
					/>
				</Field>
				<div className="flex gap-2">
					{filtered ? (
						<Button variant="ghost" onClick={() => setFilters(NO_FILTERS)}>
							{t("audit.clear")}
						</Button>
					) : null}
					<Button variant="outline" onClick={() => void exportCsv()} disabled={page.entries.length === 0}>
						<DownloadIcon aria-hidden="true" data-icon="inline-start" />
						{t("audit.export")}
					</Button>
				</div>
			</section>
			<p className="text-muted-foreground text-sm" aria-live="polite">
				{busy ? t("audit.loading") : t("audit.shown", { count: page.entries.length })}
			</p>
			{page.entries.length === 0 ? (
				filtered ? (
					<p className="text-muted-foreground rounded-md border p-6 text-center text-sm">{t("audit.noMatch")}</p>
				) : (
					<NothingYet title={t("audit.emptyTitle")} body={t("audit.emptyBody")} />
				)
			) : (
				<AuditTable entries={page.entries} names={page.names} caption={t("audit.tableLabel")} />
			)}
			{page.next ? (
				<div>
					<Button type="button" variant="outline" onClick={() => void showOlder()} disabled={busy}>
						{t("audit.older")}
					</Button>
				</div>
			) : null}
		</div>
	);
}

/** A person's own activity (Your account › Activity): the same table, with older pages, no filters. */
export function ActivityList({ first }: { first: AuditPage }) {
	const t = useT();
	const [page, setPage] = useState({ entries: first.entries, next: first.next, names: first as Names });
	const [busy, setBusy] = useState(false);
	const showOlder = async () => {
		if (!page.next) return;
		setBusy(true);
		try {
			const read = await (await getApi()).me.activity({ after: page.next });
			setPage((current) => ({
				entries: [...current.entries, ...read.entries],
				next: read.next,
				names: mergeNames(current.names, read),
			}));
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	if (page.entries.length === 0) {
		return <NothingYet title={t("activity.emptyTitle")} body={t("activity.emptyBody")} />;
	}
	return (
		<div className="flex flex-col gap-4">
			<AuditTable entries={page.entries} names={page.names} caption={t("activity.tableLabel")} />
			{page.next ? (
				<div>
					<Button type="button" variant="outline" onClick={() => void showOlder()} disabled={busy}>
						{t("audit.older")}
					</Button>
				</div>
			) : null}
		</div>
	);
}

/**
 * Entries, newest first: when (UTC), who, what in words, where and how, and each entry's details
 * behind a disclosure. Details are plain JSON shown as text: never markup.
 */
function AuditTable({ entries, names, caption }: { entries: readonly AuditEntry[]; names: Names; caption: string }) {
	const t = useT();
	const words = useAuditWords();
	const ids = useId();
	const columns: MessageKey[] = [
		"audit.columns.time",
		"audit.columns.who",
		"audit.columns.action",
		"audit.columns.where",
		"audit.columns.how",
	];
	return (
		<section
			aria-labelledby={`${ids}-caption`}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
			tabIndex={0}
			className="focus-visible:ring-ring/50 overflow-x-auto rounded-lg border outline-none focus-visible:ring-[3px]"
		>
			<table className="w-full text-start text-sm">
				<caption id={`${ids}-caption`} className="sr-only">
					{caption}
				</caption>
				<thead className="bg-muted/50">
					<tr>
						{columns.map((column) => (
							<th key={column} scope="col" className="px-3 py-2 text-start font-medium whitespace-nowrap">
								{t(column)}
							</th>
						))}
					</tr>
				</thead>
				<tbody className="divide-y">
					{entries.map((entry) => {
						const action = words.action(entry.action);
						const details = Object.keys(entry.details).length > 0;
						return (
							<tr key={entry.id} className="align-top">
								<td className="px-3 py-2 whitespace-nowrap tabular-nums">{formatUtc(entry.at)}</td>
								<td className="min-w-40 px-3 py-2">{words.who(entry, names)}</td>
								<td className="min-w-48 px-3 py-2">
									{details ? (
										<details>
											<summary className="focus-visible:ring-ring/50 cursor-pointer rounded-sm outline-none focus-visible:ring-[3px]">
												{action}
												<span className="sr-only">: {t("audit.details")}</span>
											</summary>
											<pre className="bg-muted mt-2 max-w-md overflow-x-auto rounded-md p-2 text-xs break-all whitespace-pre-wrap">
												{JSON.stringify(entry.details, null, 2)}
											</pre>
										</details>
									) : (
										action
									)}
								</td>
								<td className="min-w-40 px-3 py-2">{words.where(entry, names)}</td>
								<td className="px-3 py-2 whitespace-nowrap">{words.how(entry.via)}</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</section>
	);
}

function FilterSelect({
	id,
	label,
	value,
	onChange,
	any,
	options,
}: {
	id: string;
	label: string;
	value: string;
	onChange: (value: string) => void;
	any: string;
	options: readonly { value: string; label: string }[];
}) {
	return (
		<Field className="w-48">
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<NativeSelect id={id} value={value} onChange={(event) => onChange(event.target.value)} className="w-full">
				<NativeSelectOption value="">{any}</NativeSelectOption>
				{options.map((option) => (
					<NativeSelectOption key={option.value} value={option.value}>
						{option.label}
					</NativeSelectOption>
				))}
			</NativeSelect>
		</Field>
	);
}

function NothingYet({ title, body }: { title: string; body: string }) {
	return (
		<Empty className="border">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<ScrollTextIcon aria-hidden="true" />
				</EmptyMedia>
				<EmptyTitle>
					<h2>{title}</h2>
				</EmptyTitle>
				<EmptyDescription>{body}</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

function mergeNames(current: Names, more: Names): Names {
	return {
		people: { ...current.people, ...more.people },
		workspaces: { ...current.workspaces, ...more.workspaces },
		sites: { ...current.sites, ...more.sites },
	};
}
