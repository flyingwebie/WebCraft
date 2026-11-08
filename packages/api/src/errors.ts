import { ORPCError } from "@orpc/server";
import { EmailInUseError, InvalidCredentialsError, InvalidEmailError, PasswordRefusedError } from "@webcraft/auth";
import {
	AccessNotHeldError,
	AlreadyMemberError,
	EmailAlwaysSentError,
	EntryIncompleteError,
	EntryInvalidError,
	EntryNotFoundError,
	EntrySlugTakenError,
	InviteForAnotherAccountError,
	InviteInvalidError,
	MemberNotFoundError,
	PermissionDeniedError,
	PostTypeInvalidError,
	PostTypeNotFoundError,
	PostTypeTakenError,
	SetupClosedError,
	SetupStageError,
	SetupTokenInvalidError,
	SiteNotFoundError,
	SlugInvalidError,
	SlugTakenError,
	StaffMembershipError,
	StaffNotFoundError,
	TemplateNotFoundError,
	WorkspaceNotFoundError,
} from "@webcraft/core";
import { ElementTreeInvalidError } from "@webcraft/renderer";

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
	if (error instanceof PostTypeNotFoundError) {
		return new ORPCError("POST_TYPE_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof EntryNotFoundError) {
		return new ORPCError("ENTRY_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof TemplateNotFoundError) {
		return new ORPCError("TEMPLATE_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof PostTypeInvalidError) {
		return new ORPCError("POST_TYPE_INVALID", {
			status: 400,
			message: error.message,
			data: { problems: error.problems },
			cause: error,
		});
	}
	if (error instanceof PostTypeTakenError) {
		return new ORPCError("POST_TYPE_TAKEN", {
			status: 409,
			message: error.message,
			data: { field: error.field },
			cause: error,
		});
	}
	if (error instanceof EntryInvalidError) {
		return new ORPCError("ENTRY_INVALID", {
			status: 400,
			message: error.message,
			data: { problems: error.problems },
			cause: error,
		});
	}
	if (error instanceof EntrySlugTakenError) {
		return new ORPCError("ENTRY_SLUG_TAKEN", {
			status: 409,
			message: error.message,
			data: { slug: error.slug },
			cause: error,
		});
	}
	if (error instanceof EntryIncompleteError) {
		return new ORPCError("ENTRY_INCOMPLETE", {
			status: 400,
			message: error.message,
			data: { missing: error.missing },
			cause: error,
		});
	}
	if (error instanceof ElementTreeInvalidError) {
		return new ORPCError("TEMPLATE_INVALID", {
			status: 400,
			message: error.message,
			data: { problems: error.problems },
			cause: error,
		});
	}
	if (error instanceof StaffNotFoundError) {
		return new ORPCError("STAFF_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof InviteInvalidError) {
		return new ORPCError("INVITE_INVALID", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof InviteForAnotherAccountError) {
		return new ORPCError("INVITE_OTHER_ACCOUNT", { status: 403, message: error.message, cause: error });
	}
	if (error instanceof MemberNotFoundError) {
		return new ORPCError("MEMBER_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof AlreadyMemberError) {
		return new ORPCError("ALREADY_MEMBER", { status: 409, message: error.message, cause: error });
	}
	if (error instanceof StaffMembershipError) {
		return new ORPCError("STAFF_MEMBERSHIP", { status: 409, message: error.message, cause: error });
	}
	if (error instanceof AccessNotHeldError) {
		return new ORPCError("ACCESS_NOT_HELD", {
			status: 403,
			message: error.message,
			data: { problem: error.problem },
			cause: error,
		});
	}
	if (error instanceof PermissionDeniedError) {
		return new ORPCError("FORBIDDEN", {
			status: 403,
			message: error.message,
			data: { permission: error.permission },
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
