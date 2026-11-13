/**
 * The kinds of Media item. This module imports nothing, so the admin's browser code reads the same
 * list (`@webcraft/core/media-kinds`) that the server sorts uploads into.
 */
export const MEDIA_KINDS = ["image", "document", "video", "audio"] as const;

export type MediaKind = (typeof MEDIA_KINDS)[number];
