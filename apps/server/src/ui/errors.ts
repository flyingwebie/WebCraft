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
		case "EMAIL_ALWAYS_SENT":
			return `errors.${code}`;
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
