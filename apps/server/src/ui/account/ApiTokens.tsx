import { useRouter } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
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
import {
	Field,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { CopyIcon, PlusIcon } from "lucide-react";
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";
import { PageHeader } from "../PageHeader.tsx";

/** What the screen shows: the person's tokens, and the Workspaces (with their Sites) they may make one for. */
export type ApiTokensData = Awaited<ReturnType<ApiClient["apiTokens"]["list"]>>;

type TokenView = ApiTokensData["tokens"][number];

const LIFETIMES: { value: "30" | "90" | "365" | "never"; label: MessageKey }[] = [
	{ value: "30", label: "account.apiTokens.lifetime30" },
	{ value: "90", label: "account.apiTokens.lifetime90" },
	{ value: "365", label: "account.apiTokens.lifetime365" },
	{ value: "never", label: "account.apiTokens.lifetimeNever" },
];

/**
 * Your account › API tokens: the tokens scripts and AI clients use to act as the person through the
 * Management API (`/api/v1`), within one Workspace. Making one is a Sensitive action and shows the
 * token once; revoking one stops it at once.
 */
export function ApiTokensPage({ data }: { data: ApiTokensData }) {
	const t = useT();
	const createButton = useRef<HTMLButtonElement>(null);
	const [creating, setCreating] = useState(false);
	const [shown, setShown] = useState<{ name: string; secret: string } | null>(null);
	const canCreate = data.workspaces.length > 0;
	return (
		<>
			<PageHeader
				heading={t("account.apiTokens.heading")}
				action={
					canCreate ? (
						<Button ref={createButton} onClick={() => setCreating(true)}>
							<PlusIcon aria-hidden="true" />
							{t("account.apiTokens.create")}
						</Button>
					) : null
				}
			>
				{t("account.apiTokens.intro")}
			</PageHeader>
			<div className="grid max-w-5xl grid-cols-1 gap-6">
				{data.tokens.length === 0 ? (
					<Empty className="border">
						<EmptyHeader>
							<EmptyTitle>{t("account.apiTokens.emptyTitle")}</EmptyTitle>
							<EmptyDescription>
								{canCreate ? t("account.apiTokens.emptyBody") : t("account.apiTokens.noWorkspaces")}
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<TokenList tokens={data.tokens} />
				)}
				<p className="text-muted-foreground text-sm">
					{t("account.apiTokens.howTo", { path: "/api/v1", document: "/api/v1/openapi.json" })}
				</p>
			</div>
			{creating ? (
				<CreateTokenDialog
					workspaces={data.workspaces}
					onClose={() => setCreating(false)}
					onCreated={setShown}
					finalFocus={createButton}
				/>
			) : null}
			{shown ? <TokenShownDialog {...shown} onClose={() => setShown(null)} /> : null}
		</>
	);
}

function TokenList({ tokens }: { tokens: TokenView[] }) {
	const t = useT();
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>{t("account.apiTokens.name")}</TableHead>
					<TableHead>{t("account.apiTokens.reaches")}</TableHead>
					<TableHead>{t("account.apiTokens.access")}</TableHead>
					<TableHead>{t("account.apiTokens.expires")}</TableHead>
					<TableHead>{t("account.apiTokens.lastUsed")}</TableHead>
					<TableHead>{t("account.apiTokens.status")}</TableHead>
					<TableHead>
						<span className="sr-only">{t("account.apiTokens.actions")}</span>
					</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{tokens.map((token) => (
					<TokenRow key={token.id} token={token} />
				))}
			</TableBody>
		</Table>
	);
}

function TokenRow({ token }: { token: TokenView }) {
	const t = useT();
	const revokeButton = useRef<HTMLButtonElement>(null);
	const [revoking, setRevoking] = useState(false);
	const sites =
		token.sites === "all"
			? t("account.apiTokens.allSites")
			: token.sites.map((site) => site.name).join(", ") || t("account.apiTokens.noSites");
	return (
		<TableRow>
			<TableCell>
				<span className="flex flex-col">
					<span className="font-medium">{token.name}</span>
					<span className="text-muted-foreground font-mono text-xs">
						{t("account.apiTokens.hint", { hint: token.hint })}
					</span>
				</span>
			</TableCell>
			<TableCell>
				<span className="flex flex-col">
					<span>{token.workspace.name}</span>
					<span className="text-muted-foreground text-xs">{sites}</span>
				</span>
			</TableCell>
			<TableCell>{token.readOnly ? t("account.apiTokens.readOnly") : t("account.apiTokens.readWrite")}</TableCell>
			<TableCell>{token.expiresAt ? formatUtc(token.expiresAt) : t("account.apiTokens.never")}</TableCell>
			<TableCell>{token.lastUsedAt ? formatUtc(token.lastUsedAt) : t("account.apiTokens.neverUsed")}</TableCell>
			<TableCell>
				<Badge variant={token.status === "active" ? "secondary" : "outline"}>
					{token.status === "active"
						? t("account.apiTokens.active")
						: token.status === "expired"
							? t("account.apiTokens.expired")
							: token.revokedReason === "access"
								? t("account.apiTokens.revokedAccess")
								: t("account.apiTokens.revoked")}
				</Badge>
			</TableCell>
			<TableCell className="text-end">
				{token.status === "active" ? (
					<Button
						ref={revokeButton}
						variant="outline"
						size="sm"
						onClick={() => setRevoking(true)}
						aria-label={t("account.apiTokens.revokeLabel", { name: token.name })}
					>
						{t("account.apiTokens.revoke")}
					</Button>
				) : null}
				{revoking ? (
					<RevokeTokenDialog token={token} onClose={() => setRevoking(false)} finalFocus={revokeButton} />
				) : null}
			</TableCell>
		</TableRow>
	);
}

/** Making a token: its name, Workspace, Sites, whether it only reads, and how long it lasts. */
function CreateTokenDialog({
	workspaces,
	onClose,
	onCreated,
	finalFocus,
}: {
	workspaces: ApiTokensData["workspaces"];
	onClose: () => void;
	onCreated: (shown: { name: string; secret: string }) => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const id = useId();
	const router = useRouter();
	const runSensitive = useSensitiveAction();
	const [name, setName] = useState("");
	const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
	const [reach, setReach] = useState<"all" | "chosen">("all");
	const [chosen, setChosen] = useState<Set<string>>(() => new Set());
	const [readOnly, setReadOnly] = useState(false);
	const [lifetime, setLifetime] = useState<(typeof LIFETIMES)[number]["value"]>("90");
	const [problem, setProblem] = useState<{ field: "name" | "sites" | null; message: MessageKey } | null>(null);
	const [busy, setBusy] = useState(false);
	const workspace = workspaces.find((each) => each.id === workspaceId);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (name.trim() === "") {
			setProblem({ field: "name", message: "account.apiTokens.nameRequired" });
			return;
		}
		if (reach === "chosen" && chosen.size === 0) {
			setProblem({ field: "sites", message: "account.apiTokens.sitesRequired" });
			return;
		}
		setBusy(true);
		setProblem(null);
		try {
			const api = await getApi();
			const created = await runSensitive(() =>
				api.apiTokens.create({
					workspaceId,
					name: name.trim(),
					sites: reach === "all" ? "all" : [...chosen],
					readOnly,
					lifetimeDays: lifetime === "never" ? null : (Number(lifetime) as 30 | 90 | 365),
				}),
			);
			onClose();
			onCreated({ name: created.token.name, secret: created.secret });
			await router.invalidate();
		} catch (failure) {
			setProblem({ field: null, message: errorMessage(failure) });
			setBusy(false);
		}
	};

	const invalid = (field: "name" | "sites") => (problem?.field === field ? true : undefined);
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("account.apiTokens.close")} finalFocus={finalFocus} className="sm:max-w-xl">
				<form onSubmit={submit} noValidate>
					<DialogHeader>
						<DialogTitle>{t("account.apiTokens.createTitle")}</DialogTitle>
						<DialogDescription>{t("account.apiTokens.createIntro")}</DialogDescription>
					</DialogHeader>
					<FieldGroup className="my-6 gap-6">
						<Field data-invalid={invalid("name")}>
							<FieldLabel htmlFor={`${id}-name`}>{t("account.apiTokens.name")}</FieldLabel>
							<Input
								id={`${id}-name`}
								value={name}
								maxLength={100}
								required
								autoComplete="off"
								onChange={(event) => setName(event.target.value)}
								aria-invalid={invalid("name")}
								aria-describedby={`${id}-name-help${problem?.field === "name" ? ` ${id}-name-error` : ""}`}
							/>
							<FieldDescription id={`${id}-name-help`}>{t("account.apiTokens.nameHelp")}</FieldDescription>
							{problem?.field === "name" ? <FieldError id={`${id}-name-error`}>{t(problem.message)}</FieldError> : null}
						</Field>
						<Field>
							<FieldLabel htmlFor={`${id}-workspace`}>{t("account.apiTokens.workspace")}</FieldLabel>
							<NativeSelect
								id={`${id}-workspace`}
								value={workspaceId}
								onChange={(event) => {
									setWorkspaceId(event.target.value);
									setChosen(new Set());
								}}
							>
								{workspaces.map((each) => (
									<NativeSelectOption key={each.id} value={each.id}>
										{each.name}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</Field>
						<FieldSet data-invalid={invalid("sites")}>
							<FieldLegend variant="label">{t("account.apiTokens.sites")}</FieldLegend>
							<div className="flex flex-col gap-2">
								<label className="flex items-center gap-2 text-sm">
									<input
										type="radio"
										name={`${id}-reach`}
										checked={reach === "all"}
										onChange={() => setReach("all")}
										className="accent-primary size-4"
									/>
									{t("account.apiTokens.allSitesOption")}
								</label>
								<label className="flex items-center gap-2 text-sm">
									<input
										type="radio"
										name={`${id}-reach`}
										checked={reach === "chosen"}
										onChange={() => setReach("chosen")}
										className="accent-primary size-4"
									/>
									{t("account.apiTokens.chosenSitesOption")}
								</label>
								{reach === "chosen" ? (
									<div className="flex flex-col gap-2 ps-6">
										{(workspace?.sites ?? []).map((site) => (
											<label key={site.id} className="flex items-center gap-2 text-sm">
												<input
													type="checkbox"
													checked={chosen.has(site.id)}
													onChange={(event) =>
														setChosen((current) => {
															const next = new Set(current);
															if (event.target.checked) next.add(site.id);
															else next.delete(site.id);
															return next;
														})
													}
													aria-describedby={problem?.field === "sites" ? `${id}-sites-error` : undefined}
													className="accent-primary size-4"
												/>
												{site.name}
											</label>
										))}
										{workspace?.sites.length === 0 ? (
											<p className="text-muted-foreground text-sm">{t("account.apiTokens.noSitesToChoose")}</p>
										) : null}
									</div>
								) : null}
							</div>
							{problem?.field === "sites" ? (
								<FieldError id={`${id}-sites-error`}>{t(problem.message)}</FieldError>
							) : null}
						</FieldSet>
						<FieldSet>
							<FieldLegend variant="label">{t("account.apiTokens.access")}</FieldLegend>
							<div className="flex flex-col gap-2">
								<label className="flex items-center gap-2 text-sm">
									<input
										type="radio"
										name={`${id}-access`}
										checked={!readOnly}
										onChange={() => setReadOnly(false)}
										className="accent-primary size-4"
									/>
									{t("account.apiTokens.readWrite")}
								</label>
								<label className="flex items-center gap-2 text-sm">
									<input
										type="radio"
										name={`${id}-access`}
										checked={readOnly}
										onChange={() => setReadOnly(true)}
										className="accent-primary size-4"
									/>
									{t("account.apiTokens.readOnly")}
								</label>
							</div>
						</FieldSet>
						<Field>
							<FieldLabel htmlFor={`${id}-lifetime`}>{t("account.apiTokens.expires")}</FieldLabel>
							<NativeSelect
								id={`${id}-lifetime`}
								value={lifetime}
								onChange={(event) => setLifetime(event.target.value as (typeof LIFETIMES)[number]["value"])}
								aria-describedby={`${id}-lifetime-help`}
							>
								{LIFETIMES.map((option) => (
									<NativeSelectOption key={option.value} value={option.value}>
										{t(option.label)}
									</NativeSelectOption>
								))}
							</NativeSelect>
							<FieldDescription id={`${id}-lifetime-help`}>{t("account.apiTokens.lifetimeHelp")}</FieldDescription>
						</Field>
						{problem?.field === null ? <FieldError>{t(problem.message)}</FieldError> : null}
					</FieldGroup>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>
							{t("account.apiTokens.cancel")}
						</DialogClose>
						<Button type="submit" disabled={busy}>
							{t("account.apiTokens.createSubmit")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** The new token, shown this once, with a way to copy it. */
function TokenShownDialog({ name, secret, onClose }: { name: string; secret: string; onClose: () => void }) {
	const t = useT();
	const id = useId();
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(secret);
			toast.success(t("account.apiTokens.copied"));
		} catch {
			toast.error(t("errors.generic"));
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("account.apiTokens.close")}>
				<DialogHeader>
					<DialogTitle>{t("account.apiTokens.shownTitle", { name })}</DialogTitle>
					<DialogDescription>{t("account.apiTokens.shownIntro")}</DialogDescription>
				</DialogHeader>
				<Field className="my-6">
					<FieldLabel htmlFor={`${id}-token`}>{t("account.apiTokens.token")}</FieldLabel>
					<div className="flex gap-2">
						<Input
							id={`${id}-token`}
							readOnly
							value={secret}
							spellCheck={false}
							className="font-mono"
							onFocus={(event) => event.target.select()}
						/>
						<Button variant="outline" type="button" onClick={copy}>
							<CopyIcon aria-hidden="true" />
							{t("account.apiTokens.copy")}
						</Button>
					</div>
				</Field>
				<DialogFooter>
					<DialogClose render={<Button />}>{t("account.apiTokens.done")}</DialogClose>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Revoking a token: scripts using it are refused from their next request. */
function RevokeTokenDialog({
	token,
	onClose,
	finalFocus,
}: {
	token: TokenView;
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
			await api.apiTokens.revoke({ tokenId: token.id });
			toast.success(t("account.apiTokens.revokedToast", { name: token.name }));
			onClose();
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("account.apiTokens.close")} finalFocus={finalFocus}>
				<DialogHeader>
					<DialogTitle>{t("account.apiTokens.revokeTitle", { name: token.name })}</DialogTitle>
					<DialogDescription>{t("account.apiTokens.revokeText")}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>{t("account.apiTokens.cancel")}</DialogClose>
					<Button variant="destructive" onClick={revoke} disabled={busy}>
						{t("account.apiTokens.revoke")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
