import type { MessageKey } from "./i18n.tsx";

/**
 * The message to show for an error the Management API answered. API errors carry a stable code;
 * anything else (a network failure, an unexpected error) shows the generic message.
 */
export function errorMessage(error: unknown): MessageKey {
	const { code, data } = (error ?? {}) as { code?: unknown; data?: { problem?: unknown } };
	switch (code) {
		case "SETUP_TOKEN_INVALID":
		case "SETUP_CLOSED":
		case "EMAIL_INVALID":
		case "EMAIL_IN_USE":
		case "INVALID_CREDENTIALS":
		case "UNAUTHORIZED":
		case "FORBIDDEN":
		case "WORKSPACE_NOT_FOUND":
		case "SITE_NOT_FOUND":
		case "STAFF_NOT_FOUND":
		case "INVITE_INVALID":
		case "SLUG_TAKEN":
		case "EMAIL_ALWAYS_SENT":
		case "MEMBER_NOT_FOUND":
		case "ALREADY_MEMBER":
		case "STAFF_MEMBERSHIP":
		case "INVITE_OTHER_ACCOUNT":
		case "ACCOUNT_LOCKED":
		case "TOO_MANY_REQUESTS":
		case "IDENTITY_CHECK_REQUIRED":
		case "IDENTITY_CHECK_CANCELLED":
		case "SENSITIVE_ACTION_REFUSED":
		case "SESSION_NOT_FOUND":
		case "CHANGED_MEANWHILE":
		case "MEDIA_NOT_FOUND":
		case "MEDIA_FOLDER_NOT_FOUND":
		case "MEDIA_FOLDER_TAKEN":
		case "MEDIA_TOO_LARGE":
		case "MEDIA_INVALID":
		case "MEDIA_QUOTA_FULL":
		case "MEDIA_IN_TRASH":
		case "MEDIA_NOT_IN_TRASH":
		case "MEDIA_REPLACE_REFUSED":
		case "MEDIA_TYPE_REFUSED":
		case "AI_KEY_MISSING":
		case "AI_PROVIDER_FAILED":
		case "ALT_TEXT_UNAVAILABLE":
		case "STORAGE_UNREACHABLE":
		case "POST_TYPE_NOT_FOUND":
		case "POST_TYPE_INVALID":
		case "ENTRY_NOT_FOUND":
		case "ENTRY_INVALID":
		case "ENTRY_INCOMPLETE":
		case "ENTRY_SLUG_TAKEN":
		case "ENTRY_LINKED":
		case "GLOBALS_INVALID":
		case "GLOBALS_INCOMPLETE":
		case "CONSENT_BANNER_INVALID":
		case "CONSENT_RECORD_NOT_FOUND":
		case "PAGE_NOT_FOUND":
		case "PAGE_PARENT_UNPUBLISHED":
		case "PAGE_HAS_CHILDREN":
		case "EDIT_MODE_UNAVAILABLE":
		case "LANGUAGE_INVALID":
		case "LANGUAGE_TAKEN":
		case "LANGUAGE_NOT_FOUND":
		case "LOOP_NOT_FOUND":
		case "LOOP_INVALID":
		case "LOOP_INCOMPLETE":
		case "LOOP_NAME_TAKEN":
		case "ARCHIVE_UNAVAILABLE":
		case "DOMAIN_TAKEN":
		case "DOMAIN_NOT_FOUND":
		case "FORM_NOT_FOUND":
		case "FORM_INVALID":
		case "FORM_KEY_TAKEN":
		case "FORM_IN_USE":
		case "CAPTCHA_INVALID":
		case "LIBRARY_NOT_FOUND":
		case "OUTSIDE_SCRIPT_NOT_FOUND":
		case "IMPORT_FILE_REFUSED":
		case "IMPORT_FILE_NOT_FOUND":
		case "IMPORT_NOT_FOUND":
		case "IMPORT_RUN_NOT_FOUND":
		case "IMPORT_INVALID":
		case "IMPORT_POST_TYPE_FIXED":
		case "IMPORT_RUNNING":
		case "IMPORT_UNDO_REFUSED":
			return `errors.${code}`;
		case "DOMAIN_INVALID":
			return (data as { reason?: unknown } | undefined)?.reason === "install"
				? "errors.DOMAIN_INSTALL"
				: "errors.DOMAIN_INVALID";
		case "DOMAIN_CHANGE_REFUSED":
			return data?.problem === "language" ? "errors.DOMAIN_IS_LANGUAGES" : "errors.DOMAIN_NOT_VERIFIED";
		case "POST_TYPE_TAKEN":
			return (data as { field?: unknown } | undefined)?.field === "key"
				? "errors.POST_TYPE_TAKEN_KEY"
				: "errors.POST_TYPE_TAKEN_URL_PATTERN";
		case "PATH_TAKEN": {
			const kind = (data as { by?: { kind?: unknown } } | undefined)?.by?.kind;
			return kind === "page"
				? "errors.PATH_TAKEN_BY_PAGE"
				: kind === "language"
					? "errors.PATH_TAKEN_BY_LANGUAGE"
					: kind === "archive"
						? "errors.PATH_TAKEN_BY_ARCHIVE"
						: "errors.PATH_TAKEN_BY_POST_TYPE";
		}
		case "CONFIRMATION_INVALID":
			return data?.problem === "expired"
				? "errors.CONFIRMATION_EXPIRED"
				: data?.problem === "changed"
					? "errors.CONFIRMATION_CHANGED"
					: "errors.CONFIRMATION_INVALID";
		case "MEDIA_IMPORT_REFUSED":
			switch (data?.problem) {
				case "scheme":
					return "errors.MEDIA_IMPORT_REFUSED_SCHEME";
				case "host":
				case "address":
					return "errors.MEDIA_IMPORT_REFUSED_ADDRESS";
				case "redirects":
					return "errors.MEDIA_IMPORT_REFUSED_REDIRECTS";
				case "timeout":
					return "errors.MEDIA_IMPORT_REFUSED_TIMEOUT";
				case "size":
					return "errors.MEDIA_IMPORT_REFUSED_SIZE";
				case "status":
					return "errors.MEDIA_IMPORT_REFUSED_STATUS";
				default:
					return "errors.MEDIA_IMPORT_REFUSED_UNREACHABLE";
			}
		case "ACCESS_NOT_HELD":
			return data?.problem === "manage" ? "errors.ACCESS_NOT_HELD_MANAGE" : "errors.ACCESS_NOT_HELD_GRANT";
		case "SLUG_INVALID":
			return data?.problem === "reserved" ? "errors.SLUG_RESERVED" : "errors.SLUG_INVALID";
		case "PASSWORD_REFUSED":
			return data?.problem === "too-long"
				? "errors.PASSWORD_TOO_LONG"
				: data?.problem === "leaked"
					? "errors.PASSWORD_LEAKED"
					: "errors.PASSWORD_TOO_SHORT";
		default:
			return "errors.generic";
	}
}

/** The API error code, if the error came from the Management API. */
export function errorCode(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : undefined;
}
