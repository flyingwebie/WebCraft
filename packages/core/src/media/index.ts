/**
 * The Media library (ADRs 0026, 0027): uploads, where files are stored (local disk or an
 * S3-compatible bucket), the worker's image processing, and the files each Site serves under
 * `/_media/` on its own domain.
 */
export {
	MediaFolderNotFoundError,
	MediaFolderTakenError,
	MediaInTrashError,
	MediaInvalidError,
	MediaNotFoundError,
	MediaNotInTrashError,
	type MediaProblem,
	MediaQuotaFullError,
	MediaTooLargeError,
	MediaTypeRefusedError,
	StorageUnreachableError,
} from "./errors.ts";
export {
	type ImageInput,
	type ImageProcessor,
	ImageUnreadableError,
	imagesOnlyInWorker,
	type OriginalFormat,
	type ProcessedImage,
	VARIANT_FORMATS,
	VARIANT_WIDTHS,
	type VariantFormat,
	variantWidths,
} from "./images.ts";
export {
	type InstallStorage,
	STORAGE_S3_SECRET,
	type StorageChange,
	type StorageSettings,
} from "./install-storage.ts";
export { mediaProcess, mediaVariants } from "./jobs.ts";
export { MEDIA_KINDS, type MediaKind } from "./kinds.ts";
export {
	MEDIA_FOLDER_NAME_MAX_LENGTH,
	type MediaChange,
	type MediaDeletion,
	type MediaFolder,
	type MediaItem,
	type MediaLibrary,
	type MediaOverview,
	type MediaQuery,
	type MediaStatus,
	type MediaTrashing,
	type MediaVariant,
	type NewUpload,
	type StoredMediaFile,
	type TrashEmptying,
} from "./library.ts";
export { MEDIA_PATH } from "./names.ts";
export { MEDIA_QUOTA_MIN_BYTES, type MediaStorage, QUOTA_WARNING_SHARE } from "./quota.ts";
export type { S3Settings } from "./s3-storage.ts";
export type { ByteRange, StorageBackend, StorageKind } from "./storage.ts";
export { MEDIA_TEXT_MAX_LENGTH, type MediaText } from "./texts.ts";
export { mediaPurge, mediaPurgeSchedule, TRASH_LIFETIME_MS } from "./trash.ts";
export type { MediaUse, MediaUseSource, UseVersion } from "./usage.ts";
