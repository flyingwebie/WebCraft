import type { ApiClient } from "@webcraft/api";
import { FileTextIcon, ImageIcon, MusicIcon, VideoIcon } from "lucide-react";

/** A file of the Media library as the Management API answers it. */
export type MediaItem = Awaited<ReturnType<ApiClient["media"]["list"]>>["items"][number];

/** Where `/_media/` files are shown inside the admin: through the admin host, to people who reach the Site. */
export function previewPath(siteId: string, url: string): string {
	return `/api/media/${siteId}/${url.replace(/^\/_media\//, "")}`;
}

/** The image to show for a file: its smallest WebP width that is at least `width`, or the original. */
export function imagePreview(siteId: string, item: MediaItem, width: number): string | null {
	if (item.kind !== "image" || !item.url) return null;
	const webp = item.variants.filter((variant) => variant.format === "webp");
	const fitting = webp.find((variant) => variant.width >= width) ?? webp.at(-1);
	return previewPath(siteId, fitting?.url ?? item.url);
}

/** A file size as people read it: `840 B`, `12.4 KB`, `1.8 MB`. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The icon shown for a file that has no image preview. */
export const KIND_ICONS = { image: ImageIcon, document: FileTextIcon, video: VideoIcon, audio: MusicIcon } as const;
