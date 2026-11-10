import type { MessageKey } from "./i18n.tsx";

/**
 * The message to show for an error the Management API answered. API errors carry a stable code;
 * anything else (a network failure, an unexpected error) shows the generic message.
 */
export function errorMessage(error: unknown): MessageKey {
	const { code, data } = (error ?? {}) as { code?: unknown; data?: { problem?: unknown } };
	switch (code) {
		case "DASHBOARD_NOT_FOUND":
		case "WIDGET_NOT_FOUND":
		case "DASHBOARD_TEMPLATE_NOT_FOUND":
		case "DASHBOARD_INVALID":
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
		case "API_TOKEN_NOT_FOUND":
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
		case "REVISION_NOT_FOUND":
		case "CHECKPOINT_NOT_FOUND":
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
		case "FILTER_NOT_FOUND":
		case "FILTER_INVALID":
		case "FILTER_NAME_TAKEN":
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
		case "SMTP_PASSWORD_NEEDED":
		case "IMPORT_POST_TYPE_FIXED":
		case "IMPORT_RUNNING":
		case "IMPORT_UNDO_REFUSED":
		case "AI_CAP_REACHED":
		case "SHARED_AI_KEY_NOT_FOUND":
		case "TRANSLATION_LANGUAGE_INVALID":
		case "TRANSLATION_NOT_FOUND":
		case "PROTECTED_TERM_INVALID":
		case "PROTECTED_TERM_NOT_FOUND":
		case "STAGING_UNAVAILABLE":
		case "STAGING_PASSWORD_INVALID":
		case "PUBLISH_ALL_INVALID":
		case "PUBLISH_ALL_REFUSED":
		case "HOME_PAGE_UNPUBLISH":
		case "ALREADY_SCHEDULED":
		case "SCHEDULED_PUBLISH_NOT_FOUND":
		case "REPORT_NOT_FOUND":
		case "REPORT_SEND_NOT_FOUND":
		case "SHARE_LINK_NOT_FOUND":
		case "SHARE_LINKS_UNAVAILABLE":
		case "SERVICES_LIST_INVALID":
			return `errors.${code}`;
		case "SCHEDULE_INVALID":
			switch ((data as { reason?: unknown } | undefined)?.reason) {
				case "tooFar":
					return "errors.SCHEDULE_INVALID_TOO_FAR";
				case "notAnEntry":
					return "errors.SCHEDULE_INVALID_NOT_AN_ENTRY";
				case "nothingToTake":
					return "errors.SCHEDULE_INVALID_NOTHING_TO_TAKE";
				default:
					return "errors.SCHEDULE_INVALID_PAST";
			}
		case "REPORT_INVALID":
			switch ((data as { field?: unknown } | undefined)?.field) {
				case "name":
					return "errors.REPORT_INVALID_NAME";
				case "recipients":
					return "errors.REPORT_INVALID_RECIPIENTS";
				case "language":
					return "errors.REPORT_INVALID_LANGUAGE";
				case "reports":
					return "errors.REPORT_INVALID_REPORTS";
				default:
					return "errors.REPORT_INVALID_TEXT";
			}
		case "REPORT_SEND_REFUSED":
			switch ((data as { reason?: unknown } | undefined)?.reason) {
				case "notSent":
					return "errors.REPORT_SEND_REFUSED_NOT_SENT";
				case "noPdf":
					return "errors.REPORT_SEND_REFUSED_NO_PDF";
				case "noRecipients":
					return "errors.REPORT_SEND_REFUSED_NO_RECIPIENTS";
				default:
					return "errors.REPORT_SEND_REFUSED_NOT_HELD";
			}
		case "SHARE_LINK_INVALID":
			switch ((data as { field?: unknown } | undefined)?.field) {
				case "password":
					return "errors.SHARE_LINK_INVALID_PASSWORD";
				case "expiresAt":
					return "errors.SHARE_LINK_INVALID_EXPIRES";
				case "links":
					return "errors.SHARE_LINK_INVALID_LINKS";
				default:
					return "errors.SHARE_LINK_INVALID_NAME";
			}
		case "BRANDING_INVALID":
			switch ((data as { field?: unknown } | undefined)?.field) {
				case "accentColour":
					return "errors.BRANDING_INVALID_ACCENT";
				case "name":
					return "errors.BRANDING_INVALID_NAME";
				default:
					return "errors.BRANDING_INVALID_LOGO";
			}
		case "AI_KEY_INVALID":
			switch ((data as { field?: unknown } | undefined)?.field) {
				case "endpoint":
					return "errors.AI_KEY_INVALID_ENDPOINT";
				case "model":
					return "errors.AI_KEY_INVALID_MODEL";
				case "price":
					return "errors.AI_KEY_INVALID_PRICE";
				case "monthlyCap":
					return "errors.AI_KEY_INVALID_MONTHLY_CAP";
				case "name":
					return "errors.AI_KEY_INVALID_NAME";
				default:
					return "errors.AI_KEY_INVALID_KEY";
			}
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
