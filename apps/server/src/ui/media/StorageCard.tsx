import type { ApiClient } from "@webcraft/api";
import { TriangleAlertIcon } from "lucide-react";
import { useId } from "react";

import { useT } from "../i18n.tsx";
import { formatBytes } from "./preview.ts";

/** A Workspace's Media storage as the Management API answers it. */
export type MediaStorageView = Awaited<ReturnType<ApiClient["workspaces"]["storage"]>>;

/** How full the storage is, as a whole percentage of its quota (0 without one). */
export function percentUsed(storage: MediaStorageView): number {
	return storage.quotaBytes ? Math.min(100, Math.floor((storage.usedBytes / storage.quotaBytes) * 100)) : 0;
}

/**
 * What the Workspace's Media takes: a meter of its quota (or just the bytes used, without one), with
 * its 80% warning and the notice once it is full.
 */
export function StorageMeter({ storage, heading }: { storage: MediaStorageView; heading?: string }) {
	const t = useT();
	const labelId = useId();
	const used = formatBytes(storage.usedBytes);
	const percent = percentUsed(storage);
	const text =
		storage.quotaBytes === null
			? t("media.storage.used", { used })
			: t("media.storage.of", { used, quota: formatBytes(storage.quotaBytes) });
	return (
		<div className="grid gap-2">
			<p id={labelId} className={heading ? "text-sm font-medium" : "sr-only"}>
				{heading ?? t("media.storage.label")}
			</p>
			{storage.quotaBytes !== null ? (
				<meter
					aria-labelledby={labelId}
					aria-valuetext={text}
					min={0}
					max={100}
					low={80}
					high={99}
					optimum={0}
					value={percent}
					className="h-2 w-full"
				/>
			) : null}
			<p className="text-muted-foreground text-sm tabular-nums">{text}</p>
		</div>
	);
}

/** The notice a Workspace past 80% of its quota (or full) shows above the library. */
export function QuotaNotice({ storage }: { storage: MediaStorageView }) {
	const t = useT();
	if (!storage.warning) return null;
	return (
		<p
			className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${storage.full ? "border-destructive text-destructive" : "border-amber-600 dark:border-amber-400"}`}
		>
			<TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			<span>
				{storage.full ? t("media.storage.full") : t("media.storage.warning", { percent: percentUsed(storage) })}
			</span>
		</p>
	);
}
