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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { type RefObject, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { PageHeader } from "../PageHeader.tsx";
import { useToolsetName } from "./ToolsetChoice.tsx";

/** What the screen shows: the AI clients the person approved. */
export type AiClientsData = Awaited<ReturnType<ApiClient["aiClients"]["list"]>>;

type GrantView = AiClientsData["grants"][number];

const REVOKED: Record<NonNullable<GrantView["revokedReason"]>, MessageKey> = {
	person: "account.aiClients.revoked",
	client: "account.aiClients.revokedClient",
	access: "account.aiClients.revokedAccess",
	reuse: "account.aiClients.revokedReuse",
};

/**
 * Your account › AI clients: the AI clients the person approved, each acting as them through the
 * MCP server within one Workspace, the Sites, Toolsets and access they chose. Revoking one stops it
 * at once. Approving happens on the approval page the client sends them to.
 */
export function AiClientsPage({ data }: { data: AiClientsData }) {
	const t = useT();
	return (
		<>
			<PageHeader heading={t("account.aiClients.heading")}>{t("account.aiClients.intro")}</PageHeader>
			<div className="grid max-w-5xl grid-cols-1 gap-6">
				{data.grants.length === 0 ? (
					<Empty className="border">
						<EmptyHeader>
							<EmptyTitle>{t("account.aiClients.emptyTitle")}</EmptyTitle>
							<EmptyDescription>{t("account.aiClients.emptyBody")}</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{t("account.aiClients.client")}</TableHead>
								<TableHead>{t("account.aiClients.reaches")}</TableHead>
								<TableHead>{t("account.aiClients.access")}</TableHead>
								<TableHead>{t("account.aiClients.lastUsed")}</TableHead>
								<TableHead>{t("account.aiClients.status")}</TableHead>
								<TableHead>
									<span className="sr-only">{t("account.aiClients.actions")}</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.grants.map((grant) => (
								<GrantRow key={grant.id} grant={grant} />
							))}
						</TableBody>
					</Table>
				)}
				<p className="text-muted-foreground text-sm">{t("account.aiClients.howTo", { path: "/mcp" })}</p>
			</div>
		</>
	);
}

function GrantRow({ grant }: { grant: GrantView }) {
	const t = useT();
	const nameOf = useToolsetName();
	const revokeButton = useRef<HTMLButtonElement>(null);
	const [revoking, setRevoking] = useState(false);
	const sites =
		grant.sites === "all"
			? t("account.aiClients.allSites")
			: grant.sites.map((site) => site.name).join(", ") || t("account.aiClients.noSites");
	const access = [
		grant.readOnly ? t("account.aiClients.readOnly") : t("account.aiClients.readWrite"),
		grant.mayPublish ? t("account.aiClients.mayPublish") : null,
	].filter((part): part is string => part !== null);
	return (
		<TableRow>
			<TableCell>
				<span className="flex flex-col">
					<span className="font-medium">{grant.client.name}</span>
					<span className="text-muted-foreground text-xs">
						{t("account.aiClients.sendsBackTo", { host: grant.client.redirectHost })}
					</span>
					<span className="text-muted-foreground text-xs">
						{t("account.aiClients.approvedAt", { date: formatUtc(grant.createdAt) })}
					</span>
				</span>
			</TableCell>
			<TableCell>
				<span className="flex flex-col">
					<span>{grant.workspace.name}</span>
					<span className="text-muted-foreground text-xs">{sites}</span>
				</span>
			</TableCell>
			<TableCell>
				<span className="flex flex-col">
					<span>{access.join(" · ")}</span>
					<span className="text-muted-foreground text-xs">{grant.toolsets.map((key) => nameOf(key)).join(", ")}</span>
				</span>
			</TableCell>
			<TableCell>{grant.lastUsedAt ? formatUtc(grant.lastUsedAt) : t("account.aiClients.neverUsed")}</TableCell>
			<TableCell>
				<Badge variant={grant.status === "active" ? "secondary" : "outline"}>
					{grant.status === "active"
						? t("account.aiClients.active")
						: grant.status === "expired"
							? t("account.aiClients.expired")
							: t(REVOKED[grant.revokedReason ?? "person"])}
				</Badge>
			</TableCell>
			<TableCell className="text-end">
				{grant.status === "revoked" ? null : (
					<Button
						ref={revokeButton}
						variant="outline"
						size="sm"
						onClick={() => setRevoking(true)}
						aria-label={t("account.aiClients.revokeLabel", { name: grant.client.name })}
					>
						{t("account.aiClients.revoke")}
					</Button>
				)}
				{revoking ? <RevokeDialog grant={grant} onClose={() => setRevoking(false)} finalFocus={revokeButton} /> : null}
			</TableCell>
		</TableRow>
	);
}

/** Revoking an AI client: its next request is refused, and its tokens stop for good. */
function RevokeDialog({
	grant,
	onClose,
	finalFocus,
}: {
	grant: GrantView;
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
			await api.aiClients.revoke({ grantId: grant.id });
			toast.success(t("account.aiClients.revokedToast", { name: grant.client.name }));
			onClose();
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("account.aiClients.close")} finalFocus={finalFocus}>
				<DialogHeader>
					<DialogTitle>{t("account.aiClients.revokeTitle", { name: grant.client.name })}</DialogTitle>
					<DialogDescription>{t("account.aiClients.revokeText")}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>{t("account.aiClients.cancel")}</DialogClose>
					<Button variant="destructive" onClick={revoke} disabled={busy}>
						{t("account.aiClients.revoke")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
