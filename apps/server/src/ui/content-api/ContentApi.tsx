import { useRouter } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import type { FieldDefinition } from "@webcraft/core";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@webcraft/ui/components/card.tsx";
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
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@webcraft/ui/components/empty.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { CopyIcon, PlusIcon } from "lucide-react";
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { PageHeader } from "../PageHeader.tsx";

type View = Awaited<ReturnType<ApiClient["contentApi"]["get"]>>;
type KeyView = View["keys"][number];

/** What the screen shows: the Content API's settings and keys, and the Site's Post Types and Globals' Fields to hide. */
export type ContentApiData = {
	view: View;
	postTypes: { id: string; name: string; fields: FieldDefinition[] }[];
	globals: FieldDefinition[];
};

/**
 * Site settings › Content API (Staff only): the read-only API frontends built elsewhere call on the
 * Site's domains. Its switch and where it answers, its Content keys (each shown once, with the
 * origins browsers may send it from and how much it is used), and what it shows: Post Types and
 * Fields Staff hide never appear anywhere it answers.
 */
export function ContentApiPage({ siteId, data }: { siteId: string; data: ContentApiData }) {
	const t = useT();
	return (
		<>
			<PageHeader heading={t("contentApi.heading")}>{t("contentApi.intro")}</PageHeader>
			<div className="grid max-w-5xl grid-cols-1 gap-6">
				<SwitchCard siteId={siteId} view={data.view} />
				<KeysCard siteId={siteId} keys={data.view.keys} />
				<ShownCard siteId={siteId} data={data} />
			</div>
		</>
	);
}

function SwitchCard({ siteId, view }: { siteId: string; view: View }) {
	const t = useT();
	const id = useId();
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const toggle = async (enabled: boolean) => {
		setBusy(true);
		try {
			const api = await getApi();
			await api.contentApi.update({ siteId, enabled });
			toast.success(t(enabled ? "contentApi.switchedOn" : "contentApi.switchedOff"));
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	const addresses: { label: MessageKey; url: string }[] = [];
	if (view.addresses.main) addresses.push({ label: "contentApi.mainAddress", url: view.addresses.main });
	if (view.addresses.staging) addresses.push({ label: "contentApi.stagingAddress", url: view.addresses.staging });
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t("contentApi.switchTitle")}</h2>
				</CardTitle>
				<CardDescription id={`${id}-about`}>{t("contentApi.switchIntro")}</CardDescription>
			</CardHeader>
			<CardContent className="grid gap-4">
				<label className="flex items-center gap-2 text-sm font-medium" htmlFor={`${id}-on`}>
					<Checkbox
						id={`${id}-on`}
						checked={view.enabled}
						disabled={busy}
						aria-describedby={`${id}-about`}
						onCheckedChange={(checked) => toggle(checked === true)}
					/>
					{t("contentApi.on")}
				</label>
				<dl className="grid gap-2 text-sm">
					{addresses.map((address) => (
						<div key={address.label} className="grid gap-0.5 sm:grid-cols-[12rem_1fr]">
							<dt className="text-muted-foreground">{t(address.label)}</dt>
							<dd className="font-mono break-all">{address.url}</dd>
						</div>
					))}
				</dl>
				<p className="text-muted-foreground text-sm">{t("contentApi.howTo", { header: "Authorization: Bearer" })}</p>
			</CardContent>
		</Card>
	);
}

function KeysCard({ siteId, keys }: { siteId: string; keys: KeyView[] }) {
	const t = useT();
	const createButton = useRef<HTMLButtonElement>(null);
	const [creating, setCreating] = useState(false);
	const [shown, setShown] = useState<{ name: string; secret: string } | null>(null);
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t("contentApi.keysTitle")}</h2>
				</CardTitle>
				<CardDescription>{t("contentApi.keysIntro")}</CardDescription>
				<CardAction>
					<Button ref={createButton} onClick={() => setCreating(true)}>
						<PlusIcon aria-hidden="true" />
						{t("contentApi.createKey")}
					</Button>
				</CardAction>
			</CardHeader>
			<CardContent>
				{keys.length === 0 ? (
					<Empty className="border">
						<EmptyHeader>
							<EmptyTitle>{t("contentApi.noKeysTitle")}</EmptyTitle>
							<EmptyDescription>{t("contentApi.noKeysBody")}</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{t("contentApi.name")}</TableHead>
								<TableHead>{t("contentApi.origins")}</TableHead>
								<TableHead>{t("contentApi.requests")}</TableHead>
								<TableHead>{t("contentApi.lastUsed")}</TableHead>
								<TableHead>{t("contentApi.status")}</TableHead>
								<TableHead>
									<span className="sr-only">{t("contentApi.actions")}</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{keys.map((key) => (
								<KeyRow key={key.id} siteId={siteId} contentKey={key} />
							))}
						</TableBody>
					</Table>
				)}
			</CardContent>
			{creating ? (
				<KeyDialog siteId={siteId} onClose={() => setCreating(false)} onCreated={setShown} finalFocus={createButton} />
			) : null}
			{shown ? <KeyShownDialog {...shown} onClose={() => setShown(null)} /> : null}
		</Card>
	);
}

function KeyRow({ siteId, contentKey }: { siteId: string; contentKey: KeyView }) {
	const t = useT();
	const editButton = useRef<HTMLButtonElement>(null);
	const revokeButton = useRef<HTMLButtonElement>(null);
	const [editing, setEditing] = useState(false);
	const [revoking, setRevoking] = useState(false);
	const active = contentKey.status === "active";
	return (
		<TableRow>
			<TableCell>
				<span className="flex flex-col">
					<span className="font-medium">{contentKey.name}</span>
					<span className="text-muted-foreground font-mono text-xs">
						{t("contentApi.hint", { hint: contentKey.hint })}
					</span>
				</span>
			</TableCell>
			<TableCell>
				{contentKey.origins.length === 0 ? (
					<span className="text-muted-foreground">{t("contentApi.serversOnly")}</span>
				) : (
					<ul className="font-mono text-xs">
						{contentKey.origins.map((origin) => (
							<li key={origin}>{origin}</li>
						))}
					</ul>
				)}
			</TableCell>
			<TableCell>
				<span className="flex flex-col text-sm">
					<span>{t("contentApi.today", { count: contentKey.usage.today })}</span>
					<span className="text-muted-foreground text-xs">
						{t("contentApi.lastDays", { week: contentKey.usage.last7Days, month: contentKey.usage.last30Days })}
					</span>
				</span>
			</TableCell>
			<TableCell>{contentKey.lastUsedAt ? formatUtc(contentKey.lastUsedAt) : t("contentApi.neverUsed")}</TableCell>
			<TableCell>
				<Badge variant={active ? "secondary" : "outline"}>
					{active ? t("contentApi.active") : t("contentApi.revoked")}
				</Badge>
			</TableCell>
			<TableCell className="text-end">
				{active ? (
					<span className="inline-flex gap-2">
						<Button
							ref={editButton}
							variant="outline"
							size="sm"
							onClick={() => setEditing(true)}
							aria-label={t("contentApi.editLabel", { name: contentKey.name })}
						>
							{t("contentApi.edit")}
						</Button>
						<Button
							ref={revokeButton}
							variant="outline"
							size="sm"
							onClick={() => setRevoking(true)}
							aria-label={t("contentApi.revokeLabel", { name: contentKey.name })}
						>
							{t("contentApi.revoke")}
						</Button>
					</span>
				) : null}
				{editing ? (
					<KeyDialog
						siteId={siteId}
						existing={contentKey}
						onClose={() => setEditing(false)}
						onCreated={() => {}}
						finalFocus={editButton}
					/>
				) : null}
				{revoking ? (
					<RevokeKeyDialog
						siteId={siteId}
						contentKey={contentKey}
						onClose={() => setRevoking(false)}
						finalFocus={revokeButton}
					/>
				) : null}
			</TableCell>
		</TableRow>
	);
}

/** A problem the server found with a key's name or origins, shown beside its field. */
type KeyProblem = { field: "name" | "origins" | null; message: string };

/** The server's problems with a key, in the admin's words where it has them. */
function keyProblems(failure: unknown, t: ReturnType<typeof useT>, lines: readonly string[]): KeyProblem[] {
	const { code, data } = (failure ?? {}) as { code?: string; data?: { problems?: { at: string; rule?: string }[] } };
	if (code !== "CONTENT_API_INVALID") return [{ field: null, message: t(errorMessage(failure)) }];
	return (data?.problems ?? []).map((problem) => {
		if (problem.rule === "contentKeyName") return { field: "name", message: t("contentApi.nameProblem") };
		if (problem.rule === "contentKeyOrigin") {
			const index = Number(/\[(\d+)\]/.exec(problem.at)?.[1] ?? 0);
			return { field: "origins", message: t("contentApi.originProblem", { origin: lines[index] ?? "" }) };
		}
		if (problem.rule === "contentKeyOrigins") return { field: "origins", message: t("contentApi.originsProblem") };
		if (problem.rule === "contentKeys") return { field: null, message: t("contentApi.keysProblem") };
		return { field: null, message: t("errors.generic") };
	});
}

/** Making a key (its name and origins), or changing an existing one's. */
function KeyDialog({
	siteId,
	existing,
	onClose,
	onCreated,
	finalFocus,
}: {
	siteId: string;
	existing?: KeyView;
	onClose: () => void;
	onCreated: (shown: { name: string; secret: string }) => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const id = useId();
	const router = useRouter();
	const [name, setName] = useState(existing?.name ?? "");
	const [origins, setOrigins] = useState(existing?.origins.join("\n") ?? "");
	const [problems, setProblems] = useState<KeyProblem[]>([]);
	const [busy, setBusy] = useState(false);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (name.trim() === "") {
			setProblems([{ field: "name", message: t("contentApi.nameProblem") }]);
			return;
		}
		const lines = origins
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "");
		setBusy(true);
		setProblems([]);
		try {
			const api = await getApi();
			if (existing) {
				await api.contentApi.keys.update({ siteId, keyId: existing.id, name: name.trim(), origins: lines });
				toast.success(t("contentApi.savedKey", { name: name.trim() }));
				onClose();
			} else {
				const created = await api.contentApi.keys.create({ siteId, name: name.trim(), origins: lines });
				onClose();
				onCreated({ name: created.key.name, secret: created.secret });
			}
			await router.invalidate();
		} catch (failure) {
			setProblems(keyProblems(failure, t, lines));
			setBusy(false);
		}
	};
	const about = (field: "name" | "origins") => problems.filter((problem) => problem.field === field);
	const invalid = (field: "name" | "origins") => (about(field).length > 0 ? true : undefined);
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("contentApi.close")} finalFocus={finalFocus} className="sm:max-w-xl">
				<form onSubmit={submit} noValidate>
					<DialogHeader>
						<DialogTitle>
							{existing ? t("contentApi.editTitle", { name: existing.name }) : t("contentApi.createTitle")}
						</DialogTitle>
						<DialogDescription>{t("contentApi.createIntro")}</DialogDescription>
					</DialogHeader>
					<FieldGroup className="my-6 gap-6">
						<Field data-invalid={invalid("name")}>
							<FieldLabel htmlFor={`${id}-name`}>{t("contentApi.name")}</FieldLabel>
							<Input
								id={`${id}-name`}
								value={name}
								maxLength={100}
								required
								autoComplete="off"
								onChange={(event) => setName(event.target.value)}
								aria-invalid={invalid("name")}
								aria-describedby={`${id}-name-help${invalid("name") ? ` ${id}-name-error` : ""}`}
							/>
							<FieldDescription id={`${id}-name-help`}>{t("contentApi.nameHelp")}</FieldDescription>
							{invalid("name") ? (
								<FieldError id={`${id}-name-error`}>
									{about("name")
										.map((problem) => problem.message)
										.join(" ")}
								</FieldError>
							) : null}
						</Field>
						<Field data-invalid={invalid("origins")}>
							<FieldLabel htmlFor={`${id}-origins`}>{t("contentApi.origins")}</FieldLabel>
							<Textarea
								id={`${id}-origins`}
								value={origins}
								rows={4}
								spellCheck={false}
								className="font-mono"
								placeholder="https://shop.example.com"
								onChange={(event) => setOrigins(event.target.value)}
								aria-invalid={invalid("origins")}
								aria-describedby={`${id}-origins-help${invalid("origins") ? ` ${id}-origins-error` : ""}`}
							/>
							<FieldDescription id={`${id}-origins-help`}>{t("contentApi.originsHelp")}</FieldDescription>
							{invalid("origins") ? (
								<FieldError id={`${id}-origins-error`}>
									{about("origins").map((problem) => (
										<span key={problem.message} className="block">
											{problem.message}
										</span>
									))}
								</FieldError>
							) : null}
						</Field>
						{problems
							.filter((problem) => problem.field === null)
							.map((problem) => (
								<FieldError key={problem.message}>{problem.message}</FieldError>
							))}
					</FieldGroup>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("contentApi.cancel")}</DialogClose>
						<Button type="submit" disabled={busy}>
							{existing ? t("contentApi.save") : t("contentApi.createSubmit")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** The new key, shown this once, with a way to copy it. */
function KeyShownDialog({ name, secret, onClose }: { name: string; secret: string; onClose: () => void }) {
	const t = useT();
	const id = useId();
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(secret);
			toast.success(t("contentApi.copied"));
		} catch {
			toast.error(t("errors.generic"));
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("contentApi.close")}>
				<DialogHeader>
					<DialogTitle>{t("contentApi.shownTitle", { name })}</DialogTitle>
					<DialogDescription>{t("contentApi.shownIntro")}</DialogDescription>
				</DialogHeader>
				<Field className="my-6">
					<FieldLabel htmlFor={`${id}-key`}>{t("contentApi.key")}</FieldLabel>
					<div className="flex gap-2">
						<Input
							id={`${id}-key`}
							readOnly
							value={secret}
							spellCheck={false}
							className="font-mono"
							onFocus={(event) => event.target.select()}
						/>
						<Button variant="outline" type="button" onClick={copy}>
							<CopyIcon aria-hidden="true" />
							{t("contentApi.copy")}
						</Button>
					</div>
				</Field>
				<DialogFooter>
					<DialogClose render={<Button />}>{t("contentApi.done")}</DialogClose>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Revoking a key: frontends sending it are refused from their next request. */
function RevokeKeyDialog({
	siteId,
	contentKey,
	onClose,
	finalFocus,
}: {
	siteId: string;
	contentKey: KeyView;
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const revoke = async () => {
		setBusy(true);
		try {
			const api = await getApi();
			await api.contentApi.keys.revoke({ siteId, keyId: contentKey.id });
			toast.success(t("contentApi.revokedToast", { name: contentKey.name }));
			onClose();
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("contentApi.close")} finalFocus={finalFocus}>
				<DialogHeader>
					<DialogTitle>{t("contentApi.revokeTitle", { name: contentKey.name })}</DialogTitle>
					<DialogDescription>{t("contentApi.revokeText")}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>{t("contentApi.cancel")}</DialogClose>
					<Button variant="destructive" onClick={revoke} disabled={busy}>
						{t("contentApi.revoke")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Every Field's path and label, Groups' and Repeaters' Fields under them (`address.city`). */
function fieldRows(
	fields: readonly FieldDefinition[],
	depth = 0,
	at = "",
): { path: string; label: string; depth: number }[] {
	return fields.flatMap((field) => {
		const path = `${at}${field.key}`;
		const own = { path, label: field.label, depth };
		return field.type === "group" || field.type === "repeater"
			? [own, ...fieldRows(field.fields, depth + 1, `${path}.`)]
			: [own];
	});
}

/** What the Content API shows: each Post Type and each of its Fields, and the Globals' Fields, ticked unless hidden. */
function ShownCard({ siteId, data }: { siteId: string; data: ContentApiData }) {
	const t = useT();
	const id = useId();
	const router = useRouter();
	const [hiddenTypes, setHiddenTypes] = useState(() => new Set(data.view.hidden.postTypes));
	const [hiddenFields, setHiddenFields] = useState(
		() => new Map(Object.entries(data.view.hidden.fields).map(([postTypeId, paths]) => [postTypeId, new Set(paths)])),
	);
	const [hiddenGlobals, setHiddenGlobals] = useState(() => new Set(data.view.hidden.globals));
	const [busy, setBusy] = useState(false);
	const toggled = (set: ReadonlySet<string>, value: string, shown: boolean) => {
		const next = new Set(set);
		if (shown) next.delete(value);
		else next.add(value);
		return next;
	};
	const save = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		try {
			const api = await getApi();
			await api.contentApi.update({
				siteId,
				hidden: {
					postTypes: [...hiddenTypes],
					fields: Object.fromEntries([...hiddenFields].map(([postTypeId, paths]) => [postTypeId, [...paths]])),
					globals: [...hiddenGlobals],
				},
			});
			toast.success(t("contentApi.shownSaved"));
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	const fieldList = (
		rows: { path: string; label: string; depth: number }[],
		hidden: ReadonlySet<string>,
		change: (path: string, shown: boolean) => void,
		disabled: boolean,
		prefix: string,
	) => (
		<ul className="grid gap-2">
			{rows.map((row) => (
				<li key={row.path} className={row.depth === 0 ? "" : row.depth === 1 ? "ps-6" : "ps-12"}>
					<label className="flex items-center gap-2 text-sm" htmlFor={`${prefix}-${row.path}`}>
						<Checkbox
							id={`${prefix}-${row.path}`}
							checked={!hidden.has(row.path) && !disabled}
							disabled={disabled}
							onCheckedChange={(checked) => change(row.path, checked === true)}
						/>
						<span>{row.label}</span>
						<span className="text-muted-foreground font-mono text-xs">{row.path}</span>
					</label>
				</li>
			))}
		</ul>
	);
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t("contentApi.shownTitleCard")}</h2>
				</CardTitle>
				<CardDescription>{t("contentApi.shownIntroCard")}</CardDescription>
			</CardHeader>
			<CardContent>
				<form onSubmit={save} className="grid gap-6">
					{data.postTypes.map((postType) => {
						const typeShown = !hiddenTypes.has(postType.id);
						const rows = fieldRows(postType.fields);
						return (
							<fieldset key={postType.id} className="grid gap-3 rounded-lg border p-4">
								<legend className="px-1 text-sm font-medium">{postType.name}</legend>
								<label className="flex items-center gap-2 text-sm font-medium" htmlFor={`${id}-type-${postType.id}`}>
									<Checkbox
										id={`${id}-type-${postType.id}`}
										checked={typeShown}
										onCheckedChange={(checked) =>
											setHiddenTypes((current) => toggled(current, postType.id, checked === true))
										}
									/>
									{t("contentApi.showPostType", { name: postType.name })}
								</label>
								{rows.length === 0 ? (
									<p className="text-muted-foreground text-sm">{t("contentApi.noFields")}</p>
								) : (
									fieldList(
										rows,
										hiddenFields.get(postType.id) ?? new Set(),
										(path, shown) =>
											setHiddenFields((current) => {
												const next = new Map(current);
												next.set(postType.id, toggled(current.get(postType.id) ?? new Set(), path, shown));
												return next;
											}),
										!typeShown,
										`${id}-field-${postType.id}`,
									)
								)}
							</fieldset>
						);
					})}
					<fieldset className="grid gap-3 rounded-lg border p-4">
						<legend className="px-1 text-sm font-medium">{t("contentApi.globals")}</legend>
						{data.globals.length === 0 ? (
							<p className="text-muted-foreground text-sm">{t("contentApi.noFields")}</p>
						) : (
							fieldList(
								fieldRows(data.globals),
								hiddenGlobals,
								(path, shown) => setHiddenGlobals((current) => toggled(current, path, shown)),
								false,
								`${id}-global`,
							)
						)}
					</fieldset>
					<p className="text-muted-foreground text-sm">{t("contentApi.searchNote")}</p>
					<div>
						<Button type="submit" disabled={busy}>
							{t("contentApi.saveShown")}
						</Button>
					</div>
				</form>
			</CardContent>
		</Card>
	);
}
