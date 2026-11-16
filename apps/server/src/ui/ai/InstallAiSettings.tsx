import { useRouter } from "@tanstack/react-router";
import type { AiProvider, SharedAiKeys, SharedAiKeyView } from "@webcraft/core";
import { AI_MODELS, AI_PROVIDERS } from "@webcraft/core/ai-models";
import { Button } from "@webcraft/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { EllipsisIcon, PencilIcon, PlugIcon, PlusIcon, TrashIcon } from "lucide-react";
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";
import { PageHeader } from "../PageHeader.tsx";
import { ConfirmDialog } from "../settings/confirm.tsx";
import { SettingsForm, useSettingsSection } from "../settings/form.tsx";
import {
	describedBy,
	SettingsCard,
	SettingsListRow,
	SettingsRow,
	SettingsRows,
	StateBadge,
	Switch,
} from "../settings/layout.tsx";
import { PageSheet } from "../shell/page.tsx";
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
			<PageHeader heading={t("sharedAiKeys.heading")}>{t("sharedAiKeys.intro")}</PageHeader>
			<SettingsForm>
				<div className="grid gap-6">
					<SettingsCard
						title={t("sharedAiKeys.listHeading")}
						description={t("sharedAiKeys.listIntro")}
						action={
							<Button ref={addButton} variant="outline" onClick={() => setEditing({ key: null, trigger: addButton })}>
								<PlusIcon aria-hidden="true" />
								{t("sharedAiKeys.add")}
							</Button>
						}
					>
						{data.keys.length === 0 ? (
							<p className="text-muted-foreground text-sm">{t("sharedAiKeys.none")}</p>
						) : (
							<SettingsRows>
								{data.keys.map((key) => (
									<SharedKeyRow key={key.id} sharedKey={key} onEdit={(trigger) => setEditing({ key, trigger })} />
								))}
							</SettingsRows>
						)}
					</SettingsCard>
					<Assignments data={data} />
					<PrivateEndpoints on={data.privateEndpoints} />
				</div>
			</SettingsForm>
			<SharedKeySheet
				open={editing !== null}
				sharedKey={editing?.key ?? null}
				privateEndpoints={data.privateEndpoints}
				finalFocus={editing?.trigger}
				onClose={() => setEditing(null)}
			/>
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
	const [confirming, setConfirming] = useState(false);
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
	const assigned = sharedKey.workspaces.length > 0;
	return (
		<SettingsListRow
			badge={
				<StateBadge tone={assigned ? "success" : "neutral"}>
					{assigned ? t("sharedAiKeys.assignedBadge") : t("sharedAiKeys.notAssignedBadge")}
				</StateBadge>
			}
			detail={
				<>
					<p>
						{t(PROVIDER_WORDS[sharedKey.provider])} · <span className="font-mono">{sharedKey.model}</span>
						{sharedKey.key.set ? (
							<>
								{" · "}
								<span className="font-mono">{t("aiKeys.own.keySet", { lastFour: sharedKey.key.lastFour ?? "" })}</span>
							</>
						) : null}
					</p>
					{assigned ? (
						<p>
							{t("sharedAiKeys.workspaces")}:{" "}
							{sharedKey.workspaces
								.map((workspace) =>
									t("sharedAiKeys.assignedTo", { name: workspace.name, cap: dollars(workspace.monthlyCap) }),
								)
								.join(", ")}
						</p>
					) : null}
				</>
			}
			actions={
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
						<DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
							<TrashIcon aria-hidden="true" />
							{t("sharedAiKeys.remove")}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			}
		>
			<span>{sharedKey.name}</span>
			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title={t("sharedAiKeys.removeTitle", { name: sharedKey.name })}
				confirm={t("sharedAiKeys.remove")}
				onConfirm={remove}
				finalFocus={trigger}
			>
				{assigned
					? t("sharedAiKeys.removeInUse", {
							workspaces: sharedKey.workspaces.map((workspace) => workspace.name).join(", "),
						})
					: t("sharedAiKeys.removeBody")}
			</ConfirmDialog>
		</SettingsListRow>
	);
}

/** Adds a shared key, or changes one: the key is typed again to move it to another provider or endpoint. */
function SharedKeySheet({
	open,
	sharedKey,
	privateEndpoints,
	finalFocus,
	onClose,
}: {
	open: boolean;
	sharedKey: SharedAiKeyView | null;
	privateEndpoints: boolean;
	finalFocus?: RefObject<HTMLElement | null>;
	onClose: () => void;
}) {
	const t = useT();
	const id = useId();
	return (
		<PageSheet
			open={open}
			onOpenChange={(next) => !next && onClose()}
			title={sharedKey ? t("sharedAiKeys.editTitle") : t("sharedAiKeys.addTitle")}
			description={t("sharedAiKeys.dialogIntro")}
			finalFocus={finalFocus}
			footer={
				<>
					<Button type="button" variant="outline" onClick={onClose}>
						{t("aiKeys.own.cancel")}
					</Button>
					<Button type="submit" form={`${id}-form`}>
						{t("aiKeys.own.save")}
					</Button>
				</>
			}
		>
			{open ? (
				<SharedKeyForm
					key={sharedKey?.id ?? "new"}
					formId={`${id}-form`}
					sharedKey={sharedKey}
					privateEndpoints={privateEndpoints}
					onClose={onClose}
				/>
			) : null}
		</PageSheet>
	);
}

function SharedKeyForm({
	formId,
	sharedKey,
	privateEndpoints,
	onClose,
}: {
	formId: string;
	sharedKey: SharedAiKeyView | null;
	privateEndpoints: boolean;
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
		if (busy) return;
		if (name.trim() === "" || (!sharedKey && key.trim() === "")) {
			setError("sharedAiKeys.nameAndKeyNeeded");
			return;
		}
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
		<form id={formId} onSubmit={save} noValidate>
			<FieldGroup className="gap-4">
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
						placeholder={sharedKey?.key.set ? t("aiKeys.own.keySet", { lastFour: sharedKey.key.lastFour ?? "" }) : ""}
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
		</form>
	);
}

/** Which shared key each Workspace has, with its monthly cap: one row each, saved with the foot bar. */
function Assignments({ data }: { data: SharedAiKeys }) {
	const t = useT();
	return (
		<SettingsCard title={t("sharedAiKeys.assignHeading")} description={t("sharedAiKeys.assignIntro")}>
			{data.workspaces.length === 0 ? (
				<p className="text-muted-foreground text-sm">{t("sharedAiKeys.noWorkspaces")}</p>
			) : (
				<SettingsRows>
					{data.workspaces.map((workspace) => (
						<AssignmentRow key={workspace.id} workspace={workspace} keys={data.keys} />
					))}
				</SettingsRows>
			)}
		</SettingsCard>
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
	const id = useId();
	const section = useSettingsSection({
		saved: { keyId: workspace.keyId ?? "", cap: workspace.monthlyCap === null ? "" : String(workspace.monthlyCap) },
		save: async ({ keyId, cap }) =>
			(await getApi()).sharedAiKeys.assign({
				workspace: workspace.id,
				keyId: keyId || null,
				monthlyCap: keyId ? moneyOf(cap) : null,
			}),
	});
	const { keyId, cap } = section.values;
	return (
		<div className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
			<form {...section.formProps} className="flex flex-wrap items-end gap-3">
				<p className="flex min-w-40 grow items-center gap-2 pb-2 font-medium">
					{workspace.name}
					{workspace.keyId ? <StateBadge tone="success">{t("sharedAiKeys.assignedBadge")}</StateBadge> : null}
				</p>
				<Field className="w-auto">
					<FieldLabel htmlFor={`${id}-key`}>{t("sharedAiKeys.sharedKey")}</FieldLabel>
					<NativeSelect id={`${id}-key`} value={keyId} onChange={(event) => section.set({ keyId: event.target.value })}>
						<NativeSelectOption value="">{t("sharedAiKeys.noKey")}</NativeSelectOption>
						{keys.map((key) => (
							<NativeSelectOption key={key.id} value={key.id}>
								{key.name}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</Field>
				<Field className="w-36" data-invalid={section.error ? true : undefined}>
					<FieldLabel htmlFor={`${id}-cap`}>{t("sharedAiKeys.monthlyCap")}</FieldLabel>
					<Input
						id={`${id}-cap`}
						inputMode="decimal"
						value={cap}
						disabled={!keyId}
						required={Boolean(keyId)}
						aria-invalid={section.error ? true : undefined}
						onChange={(event) => section.set({ cap: event.target.value })}
					/>
				</Field>
			</form>
			{section.error ? <FieldError>{t(section.error)}</FieldError> : null}
		</div>
	);
}

/** Whether a shared key may call a self-hosted model inside the Install's own network. */
function PrivateEndpoints({ on }: { on: boolean }) {
	const t = useT();
	const runSensitive = useSensitiveAction();
	const section = useSettingsSection({
		saved: { on },
		save: async (values) => {
			const api = await getApi();
			await runSensitive(() => api.sharedAiKeys.setPrivateEndpoints(values));
		},
	});
	return (
		<SettingsCard title={t("sharedAiKeys.privateHeading")}>
			<SettingsRows>
				<SettingsRow
					label={t("sharedAiKeys.private")}
					help={t("sharedAiKeys.privateHelp")}
					htmlFor="ai-private-endpoints"
				>
					<Switch
						id="ai-private-endpoints"
						checked={section.values.on}
						onCheckedChange={(value) => section.set({ on: value })}
						aria-describedby={describedBy("ai-private-endpoints")}
					/>
				</SettingsRow>
			</SettingsRows>
			{section.error ? <FieldError>{t(section.error)}</FieldError> : null}
		</SettingsCard>
	);
}
