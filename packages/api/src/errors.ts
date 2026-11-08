import { ORPCError } from "@orpc/server";
import { EmailInUseError, InvalidCredentialsError, InvalidEmailError, PasswordRefusedError } from "@webcraft/auth";
import {
	EmailAlwaysSentError,
	IdentityCheckRequiredError,
	InviteInvalidError,
	PermissionDeniedError,
	SensitiveActionRefusedError,
	SessionNotFoundError,
	SetupClosedError,
	SetupStageError,
	SetupTokenInvalidError,
	SiteNotFoundError,
	SlugInvalidError,
	SlugTakenError,
	StaffNotFoundError,
	WorkspaceNotFoundError,
} from "@webcraft/core";

/**
 * Turns the errors WebCraft's modules throw into API errors with a stable code, which the admin
 * translates for people. Anything else passes through as it is (an unexpected error becomes a 500).
 */
export function toApiError(error: unknown): unknown {
	if (error instanceof ORPCError) return error;
	if (error instanceof WorkspaceNotFoundError) {
		return new ORPCError("WORKSPACE_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof SiteNotFoundError) {
		return new ORPCError("SITE_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof SlugInvalidError) {
		return new ORPCError("SLUG_INVALID", {
			status: 400,
			message: error.message,
			data: { problem: error.problem },
			cause: error,
		});
	}
	if (error instanceof SlugTakenError) {
		return new ORPCError("SLUG_TAKEN", { status: 409, message: error.message, cause: error });
	}
	if (error instanceof StaffNotFoundError) {
		return new ORPCError("STAFF_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof SessionNotFoundError) {
		return new ORPCError("SESSION_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof InviteInvalidError) {
		return new ORPCError("INVITE_INVALID", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof PermissionDeniedError) {
		return new ORPCError("FORBIDDEN", {
			status: 403,
			message: error.message,
			data: { permission: error.permission },
			cause: error,
		});
	}
	if (error instanceof IdentityCheckRequiredError) {
		return new ORPCError("IDENTITY_CHECK_REQUIRED", {
			status: 403,
			message: error.message,
			data: { action: error.action },
			cause: error,
		});
	}
	if (error instanceof SensitiveActionRefusedError) {
		return new ORPCError("SENSITIVE_ACTION_REFUSED", {
			status: 403,
			message: error.message,
			data: { action: error.action },
			cause: error,
		});
	}
	if (error instanceof SetupTokenInvalidError) {
		return new ORPCError("SETUP_TOKEN_INVALID", { status: 403, message: error.message, cause: error });
	}
	if (error instanceof SetupClosedError) {
		return new ORPCError("SETUP_CLOSED", { status: 410, message: error.message, cause: error });
	}
	if (error instanceof SetupStageError) {
		return new ORPCError("SETUP_STAGE", { status: 409, message: error.message, cause: error });
	}
	if (error instanceof PasswordRefusedError) {
		return new ORPCError("PASSWORD_REFUSED", {
			status: 400,
			message: error.message,
			data: { problem: error.problem },
			cause: error,
		});
	}
	if (error instanceof InvalidEmailError) {
		return new ORPCError("EMAIL_INVALID", { status: 400, message: error.message, cause: error });
	}
	if (error instanceof EmailInUseError) {
		return new ORPCError("EMAIL_IN_USE", { status: 409, message: error.message, cause: error });
	}
	if (error instanceof EmailAlwaysSentError) {
		return new ORPCError("EMAIL_ALWAYS_SENT", {
			status: 400,
			message: error.message,
			data: { types: error.types },
			cause: error,
		});
	}
	if (error instanceof InvalidCredentialsError) {
		return new ORPCError("INVALID_CREDENTIALS", { status: 401, message: error.message, cause: error });
	}
	return error;
}
