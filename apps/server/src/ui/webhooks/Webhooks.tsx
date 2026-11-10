import { Link, useRouter } from "@tanstack/react-router";
import type { DeliveryAttemptView, DeliveryPage, DeliveryView, WebhookEvent, WebhookView } from "@webcraft/core";
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
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
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
import { RadioGroup, RadioGroupItem } from "@webcraft/ui/components/radio-group.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import {
	CopyIcon,
	EllipsisIcon,
	KeyRoundIcon,
	PencilIcon,
	PlusIcon,
	PowerIcon,
	PowerOffIcon,
	RotateCwIcon,
	SendIcon,
	TrashIcon,
} from "lucide-react";
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorCode, errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";
import { PageHeader } from "../PageHeader.tsx";

/** What the screen shows: the Site's Webhooks, the events a Webhook can receive, and one Webhook's delivery log. */
export type WebhooksData = {
	webhooks: WebhookView[];
	events: WebhookEvent[];
	log: { webhook: WebhookView; page: DeliveryPage; before: string | null } | null;
};

/**
 * Site › Webhooks (Site settings): calls to other systems when something happens on the Site, each
 * signed, retried and kept in a delivery log for 30 days. Staff add, change, test and remove them
 * (`structure.edit`); a change applies at once. Anyone else who opens it (an Owner following the
 * email about a Webhook switched off) sees each Webhook's origin, its status and its delivery log.
 */
export function WebhooksPage({ siteId, data, canEdit }: { siteId: string; data: WebhooksData; canEdit: boolean }) {
	const t = useT();
	const addButton = useRef<HTMLButtonElement>(null);
	const [adding, setAdding] = useState(false);
	const [shownSecret, setShownSecret] = useState<{ name: string; secret: string } | null>(null);
	return (
		<>
			<PageHeader
				heading={t("webhooks.heading")}
				action={
					canEdit ? (
						<Button ref={addButton} onClick={() => setAdding(true)}>
							<PlusIcon aria-hidden="true" />
							{t("webhooks.add")}
						</Button>
					) : null
				}
			>
				{t("webhooks.intro")}
			</PageHeader>
			<div className="grid max-w-5xl grid-cols-1 gap-8">
				<WebhookList
					siteId={siteId}
					webhooks={data.webhooks}
					events={data.events}
					selected={data.log?.webhook.id ?? null}
					canEdit={canEdit}
					onSecret={setShownSecret}
				/>
				{data.log ? <DeliveryLog siteId={siteId} log={data.log} canEdit={canEdit} /> : null}
				{canEdit ? <Verifying /> : null}
				<p className="text-muted-foreground text-sm">{t("webhooks.appliesAtOnce")}</p>
			</div>
			{adding ? (
				<WebhookDialog
					siteId={siteId}
					events={data.events}
					onClose={() => setAdding(false)}
					onSecret={setShownSecret}
					finalFocus={addButton}
				/>
			) : null}
			{shownSecret ? <SecretDialog {...shownSecret} onClose={() => setShownSecret(null)} /> : null}
		</>
	);
}

type ShowSecret = (shown: { name: string; secret: string }) => void;

/** The Site's Webhooks: where each goes, what it receives, whether it is on, and its newest delivery. */
function WebhookList({
	siteId,
	webhooks,
	events,
	selected,
	canEdit,
	onSecret,
}: {
	siteId: string;
	webhooks: readonly WebhookView[];
	events: readonly WebhookEvent[];
	selected: string | null;
	canEdit: boolean;
	onSecret: ShowSecret;
}) {
	const t = useT();
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t("webhooks.listTitle")}</h2>
				</CardTitle>
				<CardDescription>{t("webhooks.listIntro")}</CardDescription>
			</CardHeader>
			<CardContent>
				{webhooks.length === 0 ? (
					<p className="text-muted-foreground text-sm">{t(canEdit ? "webhooks.none" : "webhooks.noneMember")}</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{t("webhooks.webhook")}</TableHead>
								<TableHead>{t("webhooks.receives")}</TableHead>
								<TableHead>{t("webhooks.status")}</TableHead>
								<TableHead>{t("webhooks.lastDelivery")}</TableHead>
								{canEdit ? (
									<TableHead>
										<span className="sr-only">{t("webhooks.actions")}</span>
									</TableHead>
								) : null}
							</TableRow>
						</TableHeader>
						<TableBody>
							{webhooks.map((webhook) => (
								<TableRow key={webhook.id} aria-current={webhook.id === selected ? "true" : undefined}>
									<TableCell className="max-w-80">
										<div className="font-medium">{webhook.name}</div>
										<div className="text-muted-foreground font-mono text-xs break-all">{webhook.url}</div>
										{webhook.secret?.set ? (
											<div className="text-muted-foreground text-xs">
												{webhook.secret.lastFour
													? t("webhooks.secretSet", { lastFour: webhook.secret.lastFour })
													: t("webhooks.secretSetShort")}
											</div>
										) : null}
									</TableCell>
									<TableCell>{webhook.events.map((event) => eventName(t, event)).join(", ")}</TableCell>
									<TableCell>
										<WebhookStatus webhook={webhook} />
									</TableCell>
									<TableCell>
										<div className="grid gap-1">
											{webhook.lastDelivery ? (
												<span className="flex flex-wrap items-center gap-2 text-sm">
													<DeliveryStatus status={webhook.lastDelivery.status} />
													<span className="text-muted-foreground">{formatUtc(webhook.lastDelivery.at)}</span>
												</span>
											) : (
												<span className="text-muted-foreground text-sm">{t("webhooks.noDeliveries")}</span>
											)}
											<Link
												to="/sites/$siteId/webhooks"
												params={{ siteId }}
												search={{ webhook: webhook.id }}
												className="inline-flex min-h-6 items-center text-sm underline underline-offset-4"
											>
												{t("webhooks.openLog", { name: webhook.name })}
											</Link>
										</div>
									</TableCell>
									{canEdit ? (
										<TableCell className="text-end">
											<WebhookActions siteId={siteId} webhook={webhook} events={events} onSecret={onSecret} />
										</TableCell>
									) : null}
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</CardContent>
		</Card>
	);
}

function eventName(t: ReturnType<typeof useT>, event: string): string {
	return event === "publish" || event === "unpublish" || event === "formSubmitted" || event === "test"
		? t(`webhooks.events.${event}`)
		: event;
}

function WebhookStatus({ webhook }: { webhook: WebhookView }) {
	const t = useT();
	if (webhook.status === "on") {
		return (
			<span className="grid gap-1">
				<Badge variant="secondary">{t("webhooks.on")}</Badge>
				{webhook.failuresInARow > 0 ? (
					<span className="text-muted-foreground text-xs">
						{t("webhooks.failuresInARow", { count: webhook.failuresInARow })}
					</span>
				) : null}
			</span>
		);
	}
	return webhook.offReason === "failing" ? (
		<Badge variant="destructive">{t("webhooks.offFailing")}</Badge>
	) : (
		<Badge variant="outline">{t("webhooks.off")}</Badge>
	);
}

const DELIVERY_STATUS: Record<string, { key: MessageKey; variant: "secondary" | "outline" | "destructive" }> = {
	queued: { key: "webhooks.deliveryStatus.queued", variant: "outline" },
	retrying: { key: "webhooks.deliveryStatus.retrying", variant: "outline" },
	delivered: { key: "webhooks.deliveryStatus.delivered", variant: "secondary" },
	failed: { key: "webhooks.deliveryStatus.failed", variant: "destructive" },
};

function DeliveryStatus({ status }: { status: string }) {
	const t = useT();
	const shown = DELIVERY_STATUS[status] ?? DELIVERY_STATUS.queued;
	return shown ? <Badge variant={shown.variant}>{t(shown.key)}</Badge> : null;
}

/** What an attempt (or a delivery's last one) came to, in words: the receiver's status, or what went wrong. */
function answerText(
	t: ReturnType<typeof useT>,
	answer: { statusCode: number | null; problem: DeliveryAttemptView["problem"] | DeliveryView["lastProblem"] },
): string {
	const status = answer.statusCode === null ? null : t("webhooks.answer.status", { status: answer.statusCode });
	if (answer.problem === null || answer.problem === "status") return status ?? "";
	const problem = t(`webhooks.problems.${answer.problem}`);
	return status ? `${status} · ${problem}` : problem;
}

function WebhookActions({
	siteId,
	webhook,
	events,
	onSecret,
}: {
	siteId: string;
	webhook: WebhookView;
	events: readonly WebhookEvent[];
	onSecret: ShowSecret;
}) {
	const t = useT();
	const router = useRouter();
	const trigger = useRef<HTMLButtonElement>(null);
	const [dialog, setDialog] = useState<"edit" | "secret" | "remove" | null>(null);
	const close = () => setDialog(null);
	const sendTest = async () => {
		try {
			const api = await getApi();
			const { delivery } = await api.webhooks.test({ siteId, webhookId: webhook.id });
			const [attempt] = delivery.attempts;
			if (delivery.status === "delivered") {
				toast.success(
					t("webhooks.testDelivered", {
						answer: answerText(t, { statusCode: attempt?.statusCode ?? null, problem: null }),
						ms: attempt?.durationMs ?? 0,
					}),
				);
			} else {
				toast.error(
					t("webhooks.testFailed", {
						answer: answerText(t, { statusCode: attempt?.statusCode ?? null, problem: attempt?.problem ?? null }),
					}),
				);
			}
			await router.navigate({ to: "/sites/$siteId/webhooks", params: { siteId }, search: { webhook: webhook.id } });
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};
	const switchTo = async (enabled: boolean) => {
		try {
			const api = await getApi();
			await api.webhooks.setEnabled({ siteId, webhookId: webhook.id, enabled });
			toast.success(t(enabled ? "webhooks.switchedOn" : "webhooks.switchedOff", { name: webhook.name }));
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					ref={trigger}
					render={
						<Button variant="ghost" size="icon-sm" aria-label={t("webhooks.actionsOf", { name: webhook.name })} />
					}
				>
					<EllipsisIcon aria-hidden="true" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-auto min-w-52">
					<DropdownMenuItem onClick={sendTest}>
						<SendIcon aria-hidden="true" />
						{t("webhooks.sendTest")}
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => setDialog("edit")}>
						<PencilIcon aria-hidden="true" />
						{t("webhooks.edit")}
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => setDialog("secret")}>
						<KeyRoundIcon aria-hidden="true" />
						{t("webhooks.replaceSecret")}
					</DropdownMenuItem>
					{webhook.status === "on" ? (
						<DropdownMenuItem onClick={() => switchTo(false)}>
							<PowerOffIcon aria-hidden="true" />
							{t("webhooks.switchOff")}
						</DropdownMenuItem>
					) : (
						<DropdownMenuItem onClick={() => switchTo(true)}>
							<PowerIcon aria-hidden="true" />
							{t("webhooks.switchOn")}
						</DropdownMenuItem>
					)}
					<DropdownMenuSeparator />
					<DropdownMenuItem variant="destructive" onClick={() => setDialog("remove")}>
						<TrashIcon aria-hidden="true" />
						{t("webhooks.remove")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{dialog === "edit" ? (
				<WebhookDialog siteId={siteId} webhook={webhook} events={events} onClose={close} finalFocus={trigger} />
			) : null}
			{dialog === "secret" ? (
				<ReplaceSecretDialog
					siteId={siteId}
					webhook={webhook}
					onClose={close}
					onSecret={onSecret}
					finalFocus={trigger}
				/>
			) : null}
			{dialog === "remove" ? (
				<RemoveWebhookDialog siteId={siteId} webhook={webhook} onClose={close} finalFocus={trigger} />
			) : null}
		</>
	);
}

/** Why a Webhook's URL or secret was refused, in the admin's words, and which field it is about. */
function refusal(failure: unknown): { field: "url" | "secret" | null; message: MessageKey } {
	const code = errorCode(failure);
	if (code === "WEBHOOK_INVALID") {
		const { field, reason } = (failure as { data?: { field?: string; reason?: string } }).data ?? {};
		if (field === "secret") return { field: "secret", message: "errors.WEBHOOK_SECRET_INVALID" };
		const reasons: Record<string, MessageKey> = {
			scheme: "errors.WEBHOOK_URL_SCHEME",
			credentials: "errors.WEBHOOK_URL_CREDENTIALS",
			host: "errors.WEBHOOK_URL_HOST",
		};
		return { field: "url", message: reasons[reason ?? ""] ?? "errors.WEBHOOK_URL_FORMAT" };
	}
	if (code === "TOO_MANY_WEBHOOKS") return { field: null, message: "errors.TOO_MANY_WEBHOOKS" };
	if (code === "WEBHOOK_NOT_FOUND") return { field: null, message: "errors.WEBHOOK_NOT_FOUND" };
	return { field: null, message: errorMessage(failure) };
}

/** Adding a Webhook, or changing one: its name, URL and events; when adding, an optional signing secret. */
function WebhookDialog({
	siteId,
	webhook,
	events: available,
	onClose,
	onSecret,
	finalFocus,
}: {
	siteId: string;
	webhook?: WebhookView;
	events: readonly WebhookEvent[];
	onClose: () => void;
	onSecret?: ShowSecret;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const router = useRouter();
	const runSensitive = useSensitiveAction();
	const id = useId();
	const [name, setName] = useState(webhook?.name ?? "");
	const [url, setUrl] = useState(webhook?.url ?? "");
	const [events, setEvents] = useState<WebhookEvent[]>(webhook?.events ?? [...available]);
	const [secret, setSecret] = useState("");
	const [problem, setProblem] = useState<{ field: "url" | "secret" | null; message: MessageKey } | null>(null);
	const [busy, setBusy] = useState(false);
	const save = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setProblem(null);
		const chosen = available.filter((each) => events.includes(each));
		try {
			const api = await getApi();
			if (webhook) {
				await runSensitive(() => api.webhooks.update({ siteId, webhookId: webhook.id, name, url, events: chosen }));
				toast.success(t("webhooks.saved", { name: name.trim() || webhook.name }));
			} else {
				const added = await runSensitive(() =>
					api.webhooks.add({ siteId, name, url, events: chosen, secret: secret || undefined }),
				);
				toast.success(t("webhooks.added", { name: added.webhook.name }));
				if (added.secret) onSecret?.({ name: added.webhook.name, secret: added.secret });
			}
			onClose();
			await router.invalidate();
		} catch (failure) {
			const found = refusal(failure);
			if (found.field) setProblem(found);
			else toast.error(t(found.message));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("webhooks.close")} finalFocus={finalFocus} className="sm:max-w-xl">
				<form onSubmit={save} noValidate>
					<DialogHeader>
						<DialogTitle>
							{webhook ? t("webhooks.editTitle", { name: webhook.name }) : t("webhooks.addTitle")}
						</DialogTitle>
						<DialogDescription>{t("webhooks.dialogIntro")}</DialogDescription>
					</DialogHeader>
					<FieldGroup className="my-6 gap-5">
						<Field>
							<FieldLabel htmlFor={`${id}-name`}>{t("webhooks.name")}</FieldLabel>
							<Input
								id={`${id}-name`}
								value={name}
								maxLength={100}
								onChange={(change) => setName(change.target.value)}
								aria-describedby={`${id}-name-help`}
							/>
							<FieldDescription id={`${id}-name-help`}>{t("webhooks.nameHelp")}</FieldDescription>
						</Field>
						<Field data-invalid={problem?.field === "url" ? true : undefined}>
							<FieldLabel htmlFor={`${id}-url`}>{t("webhooks.url")}</FieldLabel>
							<Input
								id={`${id}-url`}
								type="url"
								value={url}
								required
								maxLength={2048}
								spellCheck={false}
								className="font-mono"
								placeholder="https://"
								onChange={(change) => setUrl(change.target.value)}
								aria-describedby={`${id}-url-help${problem?.field === "url" ? ` ${id}-url-error` : ""}`}
								aria-invalid={problem?.field === "url" ? true : undefined}
							/>
							<FieldDescription id={`${id}-url-help`}>{t("webhooks.urlHelp")}</FieldDescription>
							{problem?.field === "url" ? <FieldError id={`${id}-url-error`}>{t(problem.message)}</FieldError> : null}
						</Field>
						<FieldSet>
							<FieldLegend variant="label">{t("webhooks.receives")}</FieldLegend>
							{available.map((event) => (
								<Field key={event} orientation="horizontal">
									<Checkbox
										id={`${id}-event-${event}`}
										checked={events.includes(event)}
										onCheckedChange={(checked) =>
											setEvents((current) =>
												checked === true ? [...new Set([...current, event])] : current.filter((each) => each !== event),
											)
										}
										aria-describedby={`${id}-event-${event}-help`}
									/>
									<div className="grid gap-1">
										<FieldLabel htmlFor={`${id}-event-${event}`}>{eventName(t, event)}</FieldLabel>
										<FieldDescription id={`${id}-event-${event}-help`}>
											{event === "publish"
												? t("webhooks.eventHelp.publish")
												: event === "unpublish"
													? t("webhooks.eventHelp.unpublish")
													: event === "formSubmitted"
														? t("webhooks.eventHelp.formSubmitted")
														: null}
										</FieldDescription>
									</div>
								</Field>
							))}
						</FieldSet>
						{webhook ? null : (
							<Field data-invalid={problem?.field === "secret" ? true : undefined}>
								<FieldLabel htmlFor={`${id}-secret`}>{t("webhooks.secret")}</FieldLabel>
								<Input
									id={`${id}-secret`}
									type="password"
									autoComplete="off"
									value={secret}
									maxLength={200}
									spellCheck={false}
									className="font-mono"
									onChange={(change) => setSecret(change.target.value)}
									aria-describedby={`${id}-secret-help${problem?.field === "secret" ? ` ${id}-secret-error` : ""}`}
									aria-invalid={problem?.field === "secret" ? true : undefined}
								/>
								<FieldDescription id={`${id}-secret-help`}>{t("webhooks.secretHelp")}</FieldDescription>
								{problem?.field === "secret" ? (
									<FieldError id={`${id}-secret-error`}>{t(problem.message)}</FieldError>
								) : null}
							</Field>
						)}
					</FieldGroup>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("webhooks.cancel")}</DialogClose>
						<Button type="submit" disabled={busy || !url.trim() || events.length === 0}>
							{webhook ? t("webhooks.save") : t("webhooks.add")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** Replacing a Webhook's signing secret: a new one WebCraft makes (shown once), or one Staff give. */
function ReplaceSecretDialog({
	siteId,
	webhook,
	onClose,
	onSecret,
	finalFocus,
}: {
	siteId: string;
	webhook: WebhookView;
	onClose: () => void;
	onSecret: ShowSecret;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const router = useRouter();
	const runSensitive = useSensitiveAction();
	const id = useId();
	const [source, setSource] = useState<"made" | "given">("made");
	const [secret, setSecret] = useState("");
	const [problem, setProblem] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const save = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setProblem(null);
		try {
			const api = await getApi();
			const changed = await runSensitive(() =>
				api.webhooks.changeSecret({
					siteId,
					webhookId: webhook.id,
					secret: source === "given" ? secret : undefined,
				}),
			);
			toast.success(t("webhooks.secretReplaced", { name: webhook.name }));
			onClose();
			if (changed.secret) onSecret({ name: webhook.name, secret: changed.secret });
			await router.invalidate();
		} catch (failure) {
			const found = refusal(failure);
			if (found.field === "secret") setProblem(found.message);
			else toast.error(t(found.message));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("webhooks.close")} finalFocus={finalFocus}>
				<form onSubmit={save} noValidate>
					<DialogHeader>
						<DialogTitle>{t("webhooks.replaceSecretTitle", { name: webhook.name })}</DialogTitle>
						<DialogDescription>{t("webhooks.replaceSecretIntro")}</DialogDescription>
					</DialogHeader>
					<FieldGroup className="my-6 gap-5">
						<FieldSet>
							<FieldLegend variant="label">{t("webhooks.newSecret")}</FieldLegend>
							<RadioGroup value={source} onValueChange={(value) => setSource(value as "made" | "given")}>
								<Field orientation="horizontal">
									<RadioGroupItem value="made" id={`${id}-made`} />
									<FieldLabel htmlFor={`${id}-made`}>{t("webhooks.secretMade")}</FieldLabel>
								</Field>
								<Field orientation="horizontal">
									<RadioGroupItem value="given" id={`${id}-given`} />
									<FieldLabel htmlFor={`${id}-given`}>{t("webhooks.secretGiven")}</FieldLabel>
								</Field>
							</RadioGroup>
						</FieldSet>
						{source === "given" ? (
							<Field data-invalid={problem ? true : undefined}>
								<FieldLabel htmlFor={`${id}-secret`}>{t("webhooks.secret")}</FieldLabel>
								<Input
									id={`${id}-secret`}
									type="password"
									autoComplete="off"
									value={secret}
									required
									maxLength={200}
									spellCheck={false}
									className="font-mono"
									onChange={(change) => setSecret(change.target.value)}
									aria-describedby={`${id}-secret-help${problem ? ` ${id}-secret-error` : ""}`}
									aria-invalid={problem ? true : undefined}
								/>
								<FieldDescription id={`${id}-secret-help`}>{t("webhooks.givenSecretHelp")}</FieldDescription>
								{problem ? <FieldError id={`${id}-secret-error`}>{t(problem)}</FieldError> : null}
							</Field>
						) : null}
					</FieldGroup>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("webhooks.cancel")}</DialogClose>
						<Button type="submit" disabled={busy || (source === "given" && !secret.trim())}>
							{t("webhooks.replaceSecret")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** The signing secret WebCraft made, shown once, to copy into the receiving system. */
function SecretDialog({ name, secret, onClose }: { name: string; secret: string; onClose: () => void }) {
	const t = useT();
	const id = useId();
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(secret);
			toast.success(t("webhooks.copied"));
		} catch {
			toast.error(t("errors.generic"));
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("webhooks.close")}>
				<DialogHeader>
					<DialogTitle>{t("webhooks.secretShownTitle", { name })}</DialogTitle>
					<DialogDescription>{t("webhooks.secretShownIntro")}</DialogDescription>
				</DialogHeader>
				<Field className="my-6">
					<FieldLabel htmlFor={`${id}-secret`}>{t("webhooks.secret")}</FieldLabel>
					<div className="flex gap-2">
						<Input
							id={`${id}-secret`}
							readOnly
							value={secret}
							spellCheck={false}
							className="font-mono"
							onFocus={(event) => event.target.select()}
						/>
						<Button variant="outline" type="button" onClick={copy}>
							<CopyIcon aria-hidden="true" />
							{t("webhooks.copy")}
						</Button>
					</div>
				</Field>
				<DialogFooter>
					<DialogClose render={<Button />}>{t("webhooks.done")}</DialogClose>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Removing a Webhook, in two steps: what goes with it, then confirming. */
function RemoveWebhookDialog({
	siteId,
	webhook,
	onClose,
	finalFocus,
}: {
	siteId: string;
	webhook: WebhookView;
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const router = useRouter();
	const [asked, setAsked] = useState<{ deliveries: number; confirmation: string } | null>(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		let current = true;
		(async () => {
			try {
				const api = await getApi();
				const answer = await api.webhooks.remove({ siteId, webhookId: webhook.id });
				if (current && !answer.removed) {
					setAsked({ deliveries: answer.preview.deliveries, confirmation: answer.confirmation.id });
				}
			} catch (failure) {
				toast.error(t(errorMessage(failure)));
			}
		})();
		return () => {
			current = false;
		};
	}, [siteId, webhook.id, t]);
	const remove = async () => {
		if (!asked) return;
		setBusy(true);
		try {
			const api = await getApi();
			await api.webhooks.remove({ siteId, webhookId: webhook.id, confirmation: asked.confirmation });
			toast.success(t("webhooks.removed", { name: webhook.name }));
			onClose();
			await router.navigate({ to: "/sites/$siteId/webhooks", params: { siteId }, search: {} });
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("webhooks.close")} finalFocus={finalFocus}>
				<DialogHeader>
					<DialogTitle>{t("webhooks.removeTitle", { name: webhook.name })}</DialogTitle>
					<DialogDescription>
						{asked ? t("webhooks.removeText", { count: asked.deliveries }) : t("webhooks.removeAsking")}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>{t("webhooks.cancel")}</DialogClose>
					<Button variant="destructive" onClick={remove} disabled={busy || !asked}>
						{t("webhooks.remove")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** A Webhook's delivery log: newest first, each delivery's attempts and body, Redeliver for a failed one. */
function DeliveryLog({
	siteId,
	log,
	canEdit,
}: {
	siteId: string;
	log: NonNullable<WebhooksData["log"]>;
	canEdit: boolean;
}) {
	const t = useT();
	const { webhook, page, before } = log;
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t("webhooks.logTitle", { name: webhook.name })}</h2>
				</CardTitle>
				<CardDescription>{t("webhooks.logIntro")}</CardDescription>
				{before ? (
					<CardAction>
						<Button
							variant="outline"
							size="sm"
							render={<Link to="/sites/$siteId/webhooks" params={{ siteId }} search={{ webhook: webhook.id }} />}
							nativeButton={false}
						>
							{t("webhooks.newest")}
						</Button>
					</CardAction>
				) : null}
			</CardHeader>
			<CardContent className="grid gap-4">
				{page.deliveries.length === 0 ? (
					<p className="text-muted-foreground text-sm">{t("webhooks.noDeliveriesYet")}</p>
				) : (
					<ul className="grid gap-2">
						{page.deliveries.map((delivery) => (
							<li key={delivery.id}>
								<Delivery siteId={siteId} webhook={webhook} delivery={delivery} canEdit={canEdit} />
							</li>
						))}
					</ul>
				)}
				{page.next ? (
					<div>
						<Button
							variant="outline"
							size="sm"
							render={
								<Link
									to="/sites/$siteId/webhooks"
									params={{ siteId }}
									search={{ webhook: webhook.id, before: page.next }}
								/>
							}
							nativeButton={false}
						>
							{t("webhooks.older")}
						</Button>
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}

function Delivery({
	siteId,
	webhook,
	delivery,
	canEdit,
}: {
	siteId: string;
	webhook: WebhookView;
	delivery: DeliveryView;
	canEdit: boolean;
}) {
	const t = useT();
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const redeliver = async () => {
		setBusy(true);
		try {
			const api = await getApi();
			await api.webhooks.redeliver({ siteId, webhookId: webhook.id, deliveryId: delivery.id });
			toast.success(t("webhooks.redelivering"));
			await router.invalidate();
		} catch (failure) {
			const code = errorCode(failure);
			const problem = (failure as { data?: { problem?: string } }).data?.problem;
			toast.error(
				t(
					code === "WEBHOOK_REDELIVERY_REFUSED"
						? problem === "switched-off"
							? "errors.WEBHOOK_REDELIVERY_SWITCHED_OFF"
							: problem === "test"
								? "errors.WEBHOOK_REDELIVERY_TEST"
								: "errors.WEBHOOK_REDELIVERY_NOT_FAILED"
						: code === "WEBHOOK_DELIVERY_NOT_FOUND"
							? "errors.WEBHOOK_DELIVERY_NOT_FOUND"
							: errorMessage(failure),
				),
			);
		} finally {
			setBusy(false);
		}
	};
	const last = answerText(t, { statusCode: delivery.lastStatusCode, problem: delivery.lastProblem });
	return (
		<details className="group rounded-lg border">
			<summary className="hover:bg-muted/50 flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-lg p-3 text-sm">
				<span className="font-medium">{formatUtc(delivery.createdAt)}</span>
				<span>{eventName(t, delivery.event)}</span>
				<DeliveryStatus status={delivery.status} />
				<span className="text-muted-foreground">
					{t("webhooks.attemptCount", { count: delivery.attempts.length })}
					{last ? ` · ${last}` : ""}
				</span>
				{delivery.status === "retrying" && delivery.nextAttemptAt ? (
					<span className="text-muted-foreground">
						{t("webhooks.nextAttempt", { at: formatUtc(delivery.nextAttemptAt) })}
					</span>
				) : null}
			</summary>
			<div className="grid gap-4 border-t p-3">
				<p className="text-muted-foreground font-mono text-xs break-all">
					{t("webhooks.deliveryId", { id: delivery.id })}
				</p>
				{delivery.attempts.length > 0 ? (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{t("webhooks.attempt")}</TableHead>
								<TableHead>{t("webhooks.when")}</TableHead>
								<TableHead>{t("webhooks.duration")}</TableHead>
								<TableHead>{t("webhooks.answerColumn")}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{delivery.attempts.map((attempt) => (
								<TableRow key={attempt.number}>
									<TableCell>{attempt.number}</TableCell>
									<TableCell>{formatUtc(attempt.at)}</TableCell>
									<TableCell>{t("webhooks.milliseconds", { ms: attempt.durationMs })}</TableCell>
									<TableCell className="max-w-96">
										<div>{answerText(t, attempt)}</div>
										{attempt.excerpt ? (
											<pre className="bg-muted/40 mt-1 rounded p-2 font-mono text-xs break-all whitespace-pre-wrap">
												{attempt.excerpt}
											</pre>
										) : null}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				) : null}
				<div className="grid gap-1">
					<h3 className="text-sm font-medium">{t("webhooks.body")}</h3>
					<pre className="bg-muted/40 rounded p-2 font-mono text-xs break-all whitespace-pre-wrap">
						{prettyJson(delivery.body)}
					</pre>
				</div>
				{canEdit && delivery.status === "failed" && !delivery.test ? (
					<div>
						<Button variant="outline" size="sm" onClick={redeliver} disabled={busy || webhook.status !== "on"}>
							<RotateCwIcon aria-hidden="true" />
							{t("webhooks.redeliver")}
						</Button>
						{webhook.status !== "on" ? (
							<p className="text-muted-foreground mt-1 text-xs">{t("webhooks.redeliverWhenOn")}</p>
						) : null}
					</div>
				) : null}
			</div>
		</details>
	);
}

function prettyJson(body: string): string {
	try {
		return JSON.stringify(JSON.parse(body), null, 2);
	} catch {
		return body;
	}
}

/** How a receiving system checks a delivery: the headers and the signature scheme, in short. */
function Verifying() {
	const t = useT();
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t("webhooks.verifyTitle")}</h2>
				</CardTitle>
				<CardDescription>{t("webhooks.verifyIntro")}</CardDescription>
			</CardHeader>
			<CardContent className="grid gap-3 text-sm">
				<pre className="bg-muted/40 rounded p-3 font-mono text-xs break-all whitespace-pre-wrap">
					{
						"WebCraft-Signature: t=<seconds>,v1=<HMAC-SHA256>\nWebCraft-Delivery: <delivery id>\nWebCraft-Event: publish"
					}
				</pre>
				<p>{t("webhooks.verifySignature")}</p>
				<p>{t("webhooks.verifyDelivery")}</p>
				<p>{t("webhooks.verifyRetries")}</p>
			</CardContent>
		</Card>
	);
}
