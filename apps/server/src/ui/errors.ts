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
		case "STORAGE_UNREACHABLE":
		case "EDIT_MODE_UNAVAILABLE":
			return `errors.${code}`;
		case "MEDIA_TYPE_REFUSED":
			return (data as { reason?: unknown } | undefined)?.reason === "svg"
				? "errors.MEDIA_TYPE_REFUSED_SVG"
				: "errors.MEDIA_TYPE_REFUSED";
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
