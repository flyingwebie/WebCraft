import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { useId, useState } from "react";
import { getApi } from "../api.ts";
import { useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";
import type { ImportView, SourceFileView } from "./model.ts";

/** Credentials exist only in this form until the one-time request; never in browser storage. */
export function LiveConnection({
	siteId,
	source,
	name,
	existing,
	onChange,
	onBusy,
}: {
	siteId: string;
	source: string;
	name: string;
	existing: ImportView | null;
	onChange(file: SourceFileView | null, importId?: string): void;
	onBusy(busy: boolean): void;
}) {
	const runSensitive = useSensitiveAction();
	const t = useT();
	const ids = useId();
	const [address, setAddress] = useState(existing?.connection?.address ?? "");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [hidden, setHidden] = useState(existing?.connection?.includeHidden ?? false);
	const [importId, setImportId] = useState(existing?.id);
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const [result, setResult] = useState<{
		roles: string[];
		types: { key: string; label: string; count: number }[];
	} | null>(null);
	const changed = () => {
		setResult(null);
		onChange(null);
	};
	async function connect() {
		setBusy(true);
		onBusy(true);
		setFailed(false);
		changed();
		const credentials = username || password ? { username, applicationPassword: password } : {};
		setUsername("");
		setPassword("");
		try {
			const api = await getApi();
			const answer = await runSensitive(() =>
				api.imports.connect({ siteId, source, name, importId, address, includeHidden: hidden, ...credentials }),
			);
			setImportId(answer.importId);
			setResult(answer.connection);
			onChange(answer.file, answer.importId);
		} catch {
			setFailed(true);
		} finally {
			setBusy(false);
			onBusy(false);
		}
	}
	return (
		<div className="grid gap-4">
			<Field>
				<FieldLabel htmlFor={`${ids}-address`}>{t("imports.live.address")}</FieldLabel>
				<Input
					id={`${ids}-address`}
					type="url"
					value={address}
					disabled={busy || !!importId}
					onChange={(e) => {
						setAddress(e.target.value);
						changed();
					}}
					placeholder="https://example.com"
				/>
			</Field>
			<div className="grid gap-4 sm:grid-cols-2">
				<Field>
					<FieldLabel htmlFor={`${ids}-username`}>{t("imports.live.username")}</FieldLabel>
					<Input
						id={`${ids}-username`}
						value={username}
						autoComplete="off"
						disabled={busy}
						onChange={(e) => {
							setUsername(e.target.value);
							changed();
						}}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor={`${ids}-password`}>{t("imports.live.password")}</FieldLabel>
					<Input
						id={`${ids}-password`}
						type="password"
						value={password}
						autoComplete="new-password"
						disabled={busy}
						onChange={(e) => {
							setPassword(e.target.value);
							changed();
						}}
						aria-describedby={`${ids}-password-help`}
					/>
					<FieldDescription id={`${ids}-password-help`}>{t("imports.live.passwordHelp")}</FieldDescription>
				</Field>
			</div>
			<label className="flex items-center gap-3">
				<input
					type="checkbox"
					className="accent-primary size-4"
					checked={hidden}
					disabled={busy}
					onChange={(e) => {
						setHidden(e.target.checked);
						changed();
					}}
				/>
				{t("imports.live.hidden")}
			</label>
			<p className="text-muted-foreground text-sm">{t("imports.live.loginHelp")}</p>
			{failed ? <FieldError>{t("imports.live.failed")}</FieldError> : null}
			{result ? (
				<div role="status" className="bg-muted rounded-lg p-4">
					<p>{t("imports.live.connected", { roles: result.roles.join(", ") })}</p>
					<ul>
						{result.types.map((type) => (
							<li key={type.key}>
								{type.label}: {type.count}
							</li>
						))}
					</ul>
				</div>
			) : null}
			<Button
				type="button"
				variant="outline"
				disabled={busy || !name.trim() || !address || (!importId && (!username || !password))}
				onClick={() => void connect()}
			>
				{busy ? t("imports.live.connecting") : t("imports.live.test")}
			</Button>
			<p className="text-muted-foreground text-sm">{t("imports.live.customFields")}</p>
		</div>
	);
}
