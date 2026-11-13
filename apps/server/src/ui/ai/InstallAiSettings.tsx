import { useRouter } from "@tanstack/react-router";
import type { AiProvider, SharedAiKeys, SharedAiKeyView } from "@webcraft/core";
import { AI_MODELS, AI_PROVIDERS } from "@webcraft/core/ai-models";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
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
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { EllipsisIcon, PencilIcon, PlugIcon, PlusIcon, TrashIcon } from "lucide-react";
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";
import { PageHeader } from "../PageHeader.tsx";
import { dollars } from "../translations/AiTranslationSettings.tsx";
import { moneyOf, PROVIDER_WORDS } from "./AiKeysPage.tsx";

/**
 * Install settings › AI: the shared Install keys the Superadmin adds and assigns to Workspaces, each
 * Workspace with a required monthly cap, and whether a shared key may reach a self-hosted model inside
 * the Install's own network. Adding, changing and removing a key are Sensitive actions.
 */
export function InstallAiSettings({ data }: { data: SharedAiKeys }) {
	const t = useT();
	const addButton = useRef<HTMLButtonElement>(null);
	const [editing, setEditing] = useState<{
		key: SharedAiKeyView | null;
		trigger: RefObject<HTMLElement | null>;
	} | null>(null);
	return (
		<>
			<PageHeader
				heading={t("sharedAiKeys.heading")}
				action={
					<Button ref={addButton} onClick={() => setEditing({ key: null, trigger: addButton })}>
						<PlusIcon aria-hidden="true" />
						{t("sharedAiKeys.add")}
					</Button>
				}
			>
				{t("sharedAiKeys.intro")}
			</PageHeader>
			<div className="grid max-w-5xl gap-8">
				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("sharedAiKeys.listHeading")}</h2>
						</CardTitle>
						<CardDescription>{t("sharedAiKeys.listIntro")}</CardDescription>
					</CardHeader>
					<CardContent>
						{data.keys.length === 0 ? (
							<p className="text-muted-foreground text-sm">{t("sharedAiKeys.none")}</p>
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>{t("sharedAiKeys.name")}</TableHead>
										<TableHead>{t("sharedAiKeys.providerModel")}</TableHead>
										<TableHead>{t("sharedAiKeys.key")}</TableHead>
										<TableHead>{t("sharedAiKeys.workspaces")}</TableHead>
										<TableHead>
											<span className="sr-only">{t("sharedAiKeys.actions")}</span>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.keys.map((key) => (
										<SharedKeyRow key={key.id} sharedKey={key} onEdit={(trigger) => setEditing({ key, trigger })} />
									))}
								</TableBody>
							</Table>
						)}
					</CardContent>
				</Card>
				<Assignments data={data} />
				<PrivateEndpoints on={data.privateEndpoints} />
			</div>
			{editing ? (
				<SharedKeyDialog
					sharedKey={editing.key}
					privateEndpoints={data.privateEndpoints}
					finalFocus={editing.trigger}
					onClose={() => setEditing(null)}
				/>
			) : null}
		</>
	);
}

function SharedKeyRow({
	sharedKey,
	onEdit,
}: {
	sharedKey: SharedAiKeyView;
	onEdit: (trigger: RefObject<HTMLElement | null>) => void;
}) {
	const t = useT();
	const router = useRouter();
	const runSensitive = useSensitiveAction();
	const trigger = useRef<HTMLButtonElement>(null);
	const test = async () => {
		try {
			const result = await (await getApi()).sharedAiKeys.test({ keyId: sharedKey.id });
			if (result.ok) toast.success(t("aiKeys.own.testOk"));
			else toast.error(t("aiKeys.own.testFailed", { problem: result.problem ?? "" }));
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};
	const remove = async () => {
		try {
			const api = await getApi();
			await runSensitive(() => api.sharedAiKeys.remove({ keyId: sharedKey.id }));
			toast.success(t("sharedAiKeys.removed", { name: sharedKey.name }));
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};
	return (
		<TableRow>
			<TableCell className="font-medium">{sharedKey.name}</TableCell>
			<TableCell>
				{t(PROVIDER_WORDS[sharedKey.provider])} · <span className="font-mono">{sharedKey.model}</span>
			</TableCell>
			<TableCell className="font-mono">
				{sharedKey.key.set ? t("aiKeys.own.keySet", { lastFour: sharedKey.key.lastFour ?? "" }) : "—"}
			</TableCell>
			<TableCell className="whitespace-normal">
				{sharedKey.workspaces.length === 0
					? "—"
					: sharedKey.workspaces
							.map((workspace) =>
								t("sharedAiKeys.assignedTo", { name: workspace.name, cap: dollars(workspace.monthlyCap) }),
							)
							.join(", ")}
			</TableCell>
			<TableCell className="text-end">
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								ref={trigger}
								variant="ghost"
								size="icon-sm"
								aria-label={t("sharedAiKeys.menu", { name: sharedKey.name })}
							/>
						}
					>
						<EllipsisIcon aria-hidden="true" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onClick={() => onEdit(trigger)}>
							<PencilIcon aria-hidden="true" />
							{t("sharedAiKeys.edit")}
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => void test()}>
							<PlugIcon aria-hidden="true" />
							{t("aiKeys.own.test")}
						</DropdownMenuItem>
						<DropdownMenuItem variant="destructive" onClick={() => void remove()}>
							<TrashIcon aria-hidden="true" />
							{t("sharedAiKeys.remove")}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</TableCell>
		</TableRow>
	);
}

/** Adds a shared key, or changes one: the key is typed again to move it to another provider or endpoint. */
function SharedKeyDialog({
	sharedKey,
	privateEndpoints,
	finalFocus,
	onClose,
}: {
	sharedKey: SharedAiKeyView | null;
	privateEndpoints: boolean;
	finalFocus: RefObject<HTMLElement | null>;
	onClose: () => void;
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const runSensitive = useSensitiveAction();
	const [name, setName] = useState(sharedKey?.name ?? "");
	const [provider, setProvider] = useState<AiProvider>(sharedKey?.provider ?? "openrouter");
	const [model, setModel] = useState(sharedKey?.model ?? AI_MODELS.openrouter[0]?.id ?? "");
	const [endpoint, setEndpoint] = useState(sharedKey?.endpoint ?? "");
	const [key, setKey] = useState("");
	const [inputPrice, setInputPrice] = useState(
		sharedKey?.price && !sharedKey.price.estimated ? String(sharedKey.price.input) : "",
	);
	const [outputPrice, setOutputPrice] = useState(
		sharedKey?.price && !sharedKey.price.estimated ? String(sharedKey.price.output) : "",
	);
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const save = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			const settings = {
				name: name.trim(),
				provider,
				model: model.trim(),
				endpoint: provider === "openaiCompatible" ? endpoint.trim() : null,
				price:
					inputPrice.trim() !== "" && outputPrice.trim() !== ""
						? { input: moneyOf(inputPrice) ?? 0, output: moneyOf(outputPrice) ?? 0 }
						: null,
			};
			if (sharedKey) {
				await runSensitive(() =>
					api.sharedAiKeys.update({ keyId: sharedKey.id, ...settings, ...(key.trim() ? { key: key.trim() } : {}) }),
				);
			} else {
				await runSensitive(() => api.sharedAiKeys.add({ ...settings, key: key.trim() }));
			}
			toast.success(t("sharedAiKeys.saved", { name: settings.name }));
			await router.invalidate();
			onClose();
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("aiKeys.close")} finalFocus={finalFocus} className="sm:max-w-xl">
				<form onSubmit={save} noValidate>
					<DialogHeader>
						<DialogTitle>{sharedKey ? t("sharedAiKeys.editTitle") : t("sharedAiKeys.addTitle")}</DialogTitle>
						<DialogDescription>{t("sharedAiKeys.dialogIntro")}</DialogDescription>
					</DialogHeader>
					<FieldGroup className="my-6 gap-4">
						<Field>
							<FieldLabel htmlFor={`${id}-name`}>{t("sharedAiKeys.name")}</FieldLabel>
							<Input
								id={`${id}-name`}
								value={name}
								maxLength={100}
								required
								onChange={(event) => setName(event.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor={`${id}-provider`}>{t("aiKeys.own.provider")}</FieldLabel>
							<NativeSelect
								id={`${id}-provider`}
								value={provider}
								onChange={(event) => {
									const next = event.target.value as AiProvider;
									setProvider(next);
									setModel(AI_MODELS[next][0]?.id ?? "");
								}}
							>
								{AI_PROVIDERS.map((option) => (
									<NativeSelectOption key={option} value={option}>
										{t(PROVIDER_WORDS[option])}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</Field>
						<Field>
							<FieldLabel htmlFor={`${id}-model`}>{t("aiKeys.own.model")}</FieldLabel>
							<Input
								id={`${id}-model`}
								list={`${id}-models`}
								value={model}
								maxLength={200}
								onChange={(event) => setModel(event.target.value)}
							/>
							<datalist id={`${id}-models`}>
								{AI_MODELS[provider].map((option) => (
									<option key={option.id} value={option.id} />
								))}
							</datalist>
						</Field>
						{provider === "openaiCompatible" ? (
							<Field>
								<FieldLabel htmlFor={`${id}-endpoint`}>{t("aiKeys.own.endpoint")}</FieldLabel>
								<Input
									id={`${id}-endpoint`}
									type="url"
									value={endpoint}
									onChange={(event) => setEndpoint(event.target.value)}
								/>
								<FieldDescription>
									{privateEndpoints ? t("sharedAiKeys.endpointPrivate") : t("sharedAiKeys.endpointPublic")}
								</FieldDescription>
							</Field>
						) : null}
						<Field>
							<FieldLabel htmlFor={`${id}-key`}>{t("aiKeys.own.key")}</FieldLabel>
							<Input
								id={`${id}-key`}
								type="password"
								autoComplete="off"
								className="font-mono"
								value={key}
								placeholder={
									sharedKey?.key.set ? t("aiKeys.own.keySet", { lastFour: sharedKey.key.lastFour ?? "" }) : ""
								}
								onChange={(event) => setKey(event.target.value)}
							/>
							<FieldDescription>{sharedKey ? t("sharedAiKeys.keyKept") : t("aiKeys.own.keyHelp")}</FieldDescription>
						</Field>
						<div className="grid gap-4 sm:grid-cols-2">
							<Field>
								<FieldLabel htmlFor={`${id}-input-price`}>{t("aiKeys.own.inputPrice")}</FieldLabel>
								<Input
									id={`${id}-input-price`}
									inputMode="decimal"
									value={inputPrice}
									onChange={(event) => setInputPrice(event.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor={`${id}-output-price`}>{t("aiKeys.own.outputPrice")}</FieldLabel>
								<Input
									id={`${id}-output-price`}
									inputMode="decimal"
									value={outputPrice}
									onChange={(event) => setOutputPrice(event.target.value)}
								/>
							</Field>
						</div>
						{error ? <FieldError>{t(error)}</FieldError> : null}
					</FieldGroup>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" />}>{t("aiKeys.own.cancel")}</DialogClose>
						<Button type="submit" disabled={busy || name.trim() === "" || (!sharedKey && key.trim() === "")}>
							{t("aiKeys.own.save")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** Which shared key each Workspace has, with its monthly cap. */
function Assignments({ data }: { data: SharedAiKeys }) {
	const t = useT();
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t("sharedAiKeys.assignHeading")}</h2>
				</CardTitle>
				<CardDescription>{t("sharedAiKeys.assignIntro")}</CardDescription>
			</CardHeader>
			<CardContent>
				{data.workspaces.length === 0 ? (
					<p className="text-muted-foreground text-sm">{t("sharedAiKeys.noWorkspaces")}</p>
				) : (
					<ul className="grid gap-3">
						{data.workspaces.map((workspace) => (
							<li key={workspace.id}>
								<AssignmentRow workspace={workspace} keys={data.keys} />
							</li>
						))}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}

function AssignmentRow({
	workspace,
	keys,
}: {
	workspace: SharedAiKeys["workspaces"][number];
	keys: readonly SharedAiKeyView[];
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const [keyId, setKeyId] = useState(workspace.keyId ?? "");
	const [cap, setCap] = useState(workspace.monthlyCap === null ? "" : String(workspace.monthlyCap));
	const [error, setError] = useState<MessageKey | null>(null);
	const save = async (event: FormEvent) => {
		event.preventDefault();
		setError(null);
		try {
			await (await getApi()).sharedAiKeys.assign({
				workspace: workspace.id,
				keyId: keyId || null,
				monthlyCap: keyId ? moneyOf(cap) : null,
			});
			toast.success(t("sharedAiKeys.assigned", { name: workspace.name }));
			await router.invalidate();
		} catch (failure) {
			setError(errorMessage(failure));
		}
	};
	return (
		<form onSubmit={save} className="flex flex-wrap items-end gap-3 rounded-lg border p-3" noValidate>
			<p className="min-w-40 grow pb-2 font-medium">{workspace.name}</p>
			<Field className="w-auto">
				<FieldLabel htmlFor={`${id}-key`}>{t("sharedAiKeys.sharedKey")}</FieldLabel>
				<NativeSelect id={`${id}-key`} value={keyId} onChange={(event) => setKeyId(event.target.value)}>
					<NativeSelectOption value="">{t("sharedAiKeys.noKey")}</NativeSelectOption>
					{keys.map((key) => (
						<NativeSelectOption key={key.id} value={key.id}>
							{key.name}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</Field>
			<Field className="w-36" data-invalid={error ? true : undefined}>
				<FieldLabel htmlFor={`${id}-cap`}>{t("sharedAiKeys.monthlyCap")}</FieldLabel>
				<Input
					id={`${id}-cap`}
					inputMode="decimal"
					value={cap}
					disabled={!keyId}
					required={Boolean(keyId)}
					aria-invalid={error ? true : undefined}
					onChange={(event) => setCap(event.target.value)}
				/>
			</Field>
			<Button type="submit" variant="outline">
				{t("sharedAiKeys.saveAssignment")}
			</Button>
			{workspace.keyId ? <Badge variant="secondary">{t("sharedAiKeys.assignedBadge")}</Badge> : null}
			{error ? <FieldError className="basis-full">{t(error)}</FieldError> : null}
		</form>
	);
}

/** Whether a shared key may call a self-hosted model inside the Install's own network. */
function PrivateEndpoints({ on }: { on: boolean }) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const runSensitive = useSensitiveAction();
	const [checked, setChecked] = useState(on);
	const save = async (event: FormEvent) => {
		event.preventDefault();
		try {
			const api = await getApi();
			await runSensitive(() => api.sharedAiKeys.setPrivateEndpoints({ on: checked }));
			toast.success(t("sharedAiKeys.privateSaved"));
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t("sharedAiKeys.privateHeading")}</h2>
				</CardTitle>
			</CardHeader>
			<CardContent>
				<form onSubmit={save} className="grid gap-4" noValidate>
					<Field orientation="horizontal">
						<Checkbox
							id={`${id}-private`}
							checked={checked}
							onCheckedChange={(value) => setChecked(value === true)}
							aria-describedby={`${id}-help`}
						/>
						<FieldLabel htmlFor={`${id}-private`}>{t("sharedAiKeys.private")}</FieldLabel>
					</Field>
					<p id={`${id}-help`} className="text-muted-foreground text-sm">
						{t("sharedAiKeys.privateHelp")}
					</p>
					<div>
						<Button type="submit" variant="outline">
							{t("sharedAiKeys.savePrivate")}
						</Button>
					</div>
				</form>
			</CardContent>
		</Card>
	);
}
