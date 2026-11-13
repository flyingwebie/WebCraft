import { Link, useNavigate } from "@tanstack/react-router";
import type { SiteImportView } from "@webcraft/core";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import {
	Table,
	TableBody,
	TableCaption,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@webcraft/ui/components/table.tsx";
import { useId, useState } from "react";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { PageHeader } from "../PageHeader.tsx";

/** The status badge of a Site import. */
export function ImportStatus({ status }: { status: SiteImportView["status"] }) {
	const t = useT();
	const variant =
		status === "failed" || status === "refused" ? "destructive" : status === "done" ? "default" : "secondary";
	return <Badge variant={variant}>{t(`siteImports.status.${status}`)}</Badge>;
}

/** What a refused archive's refusal says, in the person's words. */
export function refusalText(
	t: ReturnType<typeof useT>,
	refusal: { reason: string; version?: unknown } | null | undefined,
): string {
	switch (refusal?.reason) {
		case "newer-format":
			return t("siteImports.refusal.newer-format");
		case "newer-version":
			return t("siteImports.refusal.newer-version", { version: String(refusal.version ?? "") });
		case "damaged":
			return t("siteImports.refusal.damaged");
		default:
			return t("siteImports.refusal.not-an-export");
	}
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Workspace › Site imports (Staff, `site.import`): uploads a Site export in parts (an upload that stops
 * goes on where it got to when the same file is chosen again), then opens the import, where it is
 * started as a new Site; and lists the Workspace's Site imports with their reports.
 */
export function SiteImportsPage({ workspaceId, initial }: { workspaceId: string; initial: SiteImportView[] }) {
	const t = useT();
	const navigate = useNavigate();
	const [imports, setImports] = useState(initial);
	const [percent, setPercent] = useState<number | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const fileId = useId();
	const problemId = useId();

	const upload = async (chosen: File | undefined) => {
		if (!chosen) return;
		setProblem(null);
		setPercent(0);
		try {
			const api = await getApi();
			// The same file again goes on where its upload stopped.
			const unfinished = imports.find(
				(each) => each.status === "uploading" && each.fileName === chosen.name && each.sizeBytes === chosen.size,
			);
			let view = unfinished
				? (await api.siteImports.get({ workspaceId, importId: unfinished.id })).import
				: (await api.siteImports.startUpload({ workspaceId, fileName: chosen.name, size: chosen.size })).import;
			const hashes: Uint8Array[] = [];
			for (let offset = 0; offset < chosen.size; offset += view.partBytes) {
				const part = new File([chosen.slice(offset, offset + view.partBytes)], "part");
				const bytes = new Uint8Array(await part.arrayBuffer());
				const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
				hashes.push(hash);
				if (offset + bytes.length <= view.receivedBytes) continue;
				for (let attempt = 1; ; attempt++) {
					try {
						view = (
							await api.siteImports.uploadPart({ workspaceId, importId: view.id, offset, sha256: hex(hash), part })
						).import;
						break;
					} catch (failure) {
						if (attempt >= 3) throw failure;
					}
				}
				setPercent(Math.floor(((offset + bytes.length) / chosen.size) * 100));
			}
			const all = new Uint8Array(hashes.length * 32);
			for (const [index, hash] of hashes.entries()) all.set(hash, index * 32);
			const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", all)));
			const { import: finished } = await api.siteImports.finishUpload({
				workspaceId,
				importId: view.id,
				sha256: digest,
			});
			await navigate({
				to: "/workspaces/$workspaceId/site-imports/$importId",
				params: { workspaceId, importId: finished.id },
			});
		} catch (failure) {
			const { code, data } = (failure ?? {}) as { code?: string; data?: { reason: string; version?: unknown } };
			setProblem(code === "SITE_IMPORT_REFUSED" ? refusalText(t, data) : t(errorMessage(failure) as MessageKey));
			setPercent(null);
			try {
				const api = await getApi();
				setImports((await api.siteImports.list({ workspaceId })).imports);
			} catch {
				// The list is read again on the next visit.
			}
		}
	};

	return (
		<>
			<PageHeader heading={t("siteImports.heading")}>{t("siteImports.intro")}</PageHeader>
			<div className="grid max-w-5xl grid-cols-1 gap-8">
				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("siteImports.uploadTitle")}</h2>
						</CardTitle>
					</CardHeader>
					<CardContent className="grid gap-4">
						<Field>
							<FieldLabel htmlFor={fileId}>{t("siteImports.file")}</FieldLabel>
							<Input
								id={fileId}
								type="file"
								accept=".tar,application/x-tar"
								disabled={percent !== null}
								aria-describedby={`${fileId}-help${problem ? ` ${problemId}` : ""}`}
								aria-invalid={problem ? true : undefined}
								onChange={(event) => void upload(event.target.files?.[0])}
							/>
							<FieldDescription id={`${fileId}-help`}>{t("siteImports.fileHelp")}</FieldDescription>
							{problem ? <FieldError id={problemId}>{problem}</FieldError> : null}
						</Field>
						{percent !== null ? (
							<div className="grid gap-2">
								<progress
									className="w-full accent-current"
									max={100}
									value={percent}
									aria-labelledby={`${fileId}-progress`}
								/>
								<p id={`${fileId}-progress`} className="text-muted-foreground text-sm" aria-live="polite">
									{t("siteImports.uploading", { percent })}
								</p>
							</div>
						) : null}
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("siteImports.listTitle")}</h2>
						</CardTitle>
						<CardDescription>{t("siteImports.listIntro")}</CardDescription>
					</CardHeader>
					<CardContent>
						{imports.length === 0 ? (
							<p className="text-muted-foreground text-sm">{t("siteImports.listEmpty")}</p>
						) : (
							<Table>
								<TableCaption className="sr-only">{t("siteImports.caption")}</TableCaption>
								<TableHeader>
									<TableRow>
										<TableHead>{t("siteImports.columns.file")}</TableHead>
										<TableHead>{t("siteImports.columns.site")}</TableHead>
										<TableHead>{t("siteImports.columns.status")}</TableHead>
										<TableHead>{t("siteImports.columns.created")}</TableHead>
										<TableHead>{t("siteImports.columns.by")}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{imports.map((each) => (
										<TableRow key={each.id}>
											<TableCell>
												<Link
													to="/workspaces/$workspaceId/site-imports/$importId"
													params={{ workspaceId, importId: each.id }}
													className="font-medium underline-offset-4 hover:underline"
													aria-label={t("siteImports.openLabel", { file: each.fileName })}
												>
													{each.fileName}
												</Link>
											</TableCell>
											<TableCell>{each.site?.name ?? each.archive?.site.name ?? "—"}</TableCell>
											<TableCell>
												<ImportStatus status={each.status} />
											</TableCell>
											<TableCell>{formatUtc(each.createdAt)}</TableCell>
											<TableCell>{each.startedBy?.name ?? "—"}</TableCell>
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
