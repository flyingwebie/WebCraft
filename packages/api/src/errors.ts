import { ORPCError } from "@orpc/server";
import {
	AccountLockedError,
	EmailInUseError,
	InvalidCredentialsError,
	InvalidEmailError,
	PasswordRefusedError,
} from "@webcraft/auth";
import {
	AccessNotHeldError,
	AlreadyMemberError,
	ArchiveUnavailableError,
	CaptchaInvalidError,
	ClassInUseError,
	ClassNotFoundError,
	CodeSourceNotFoundError,
	ComponentFromModuleError,
	ComponentInUseError,
	ComponentInvalidError,
	ComponentNameTakenError,
	ComponentNotFoundError,
	ConfirmationInvalidError,
	DomainChangeRefusedError,
	DomainInvalidError,
	DomainNotFoundError,
	DomainTakenError,
	DraftChangedError,
	EditFieldInvalidError,
	EditModeUnavailableError,
	EditPathInvalidError,
	EmailAlwaysSentError,
	EntryIncompleteError,
	EntryInvalidError,
	EntryLinkedError,
	EntryNotFoundError,
	EntrySlugTakenError,
	FormInUseError,
	FormInvalidError,
	FormKeyTakenError,
	FormNotFoundError,
	GlobalsIncompleteError,
	GlobalsInvalidError,
	HostInvalidError,
	IdentityCheckRequiredError,
	InviteForAnotherAccountError,
	InviteInvalidError,
	LanguageInvalidError,
	LanguageNotFoundError,
	LanguageTakenError,
	LibraryNotFoundError,
	LibraryRefusedError,
	LoopIncompleteError,
	LoopInvalidError,
	LoopNameTakenError,
	LoopNotFoundError,
	MediaFolderNotFoundError,
	MediaFolderTakenError,
	MediaInvalidError,
	MediaNotFoundError,
	MediaTooLargeError,
	MediaTypeRefusedError,
	MemberNotFoundError,
	ModuleCannotRunError,
	ModuleChangedError,
	ModuleFailedError,
	ModuleNotApprovedError,
	ModuleNotFoundError,
	OutsideScriptNotFoundError,
	PageHasChildrenError,
	PageNotFoundError,
	PageParentUnpublishedError,
	PagesHaveNoEntryTemplateError,
	PathTakenError,
	PermissionDeniedError,
	PostTypeInvalidError,
	PostTypeNotFoundError,
	PostTypeTakenError,
	RateLimitedError,
	ScriptNotFoundError,
	SensitiveActionRefusedError,
	SessionNotFoundError,
	SetupClosedError,
	SetupStageError,
	SetupTokenInvalidError,
	SiteNotFoundError,
	SlugInvalidError,
	SlugTakenError,
	SnippetInvalidError,
	StaffMembershipError,
	StaffNotFoundError,
	StorageUnreachableError,
	TemplateNotFoundError,
	TokenInUseError,
	TokensFileInvalidError,
	TooManyHostsError,
	WorkspaceNotFoundError,
} from "@webcraft/core";
import { ModuleError } from "@webcraft/module-sdk";
import { DesignSystemInvalidError, ElementTreeInvalidError, TemplateMarkupInvalidError } from "@webcraft/renderer";

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
	if (error instanceof PageHasChildrenError) {
		return new ORPCError("PAGE_HAS_CHILDREN", {
			status: 409,
			message: error.message,
			data: { children: error.children },
			cause: error,
		});
	}
	if (error instanceof PageNotFoundError) {
		return new ORPCError("PAGE_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof ScriptNotFoundError) {
		return new ORPCError("SCRIPT_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof TemplateNotFoundError) {
		return new ORPCError("TEMPLATE_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof ComponentNotFoundError) {
		return new ORPCError("COMPONENT_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof ComponentInvalidError) {
		return new ORPCError("COMPONENT_INVALID", {
			status: 400,
			message: error.message,
			data: { problems: error.problems },
			cause: error,
		});
	}
	if (error instanceof ComponentNameTakenError) {
		return new ORPCError("COMPONENT_NAME_TAKEN", {
			status: 409,
			message: error.message,
			data: { name: error.componentName, by: error.by },
			cause: error,
		});
	}
	if (error instanceof ComponentInUseError) {
		return new ORPCError("COMPONENT_IN_USE", {
			status: 409,
			message: error.message,
			data: { usedIn: error.usedIn },
			cause: error,
		});
	}
	if (error instanceof LoopNotFoundError) {
		return new ORPCError("LOOP_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof LoopInvalidError) {
		return new ORPCError("LOOP_INVALID", {
			status: 400,
			message: error.message,
			data: { problems: error.problems },
			cause: error,
		});
	}
	if (error instanceof LoopIncompleteError) {
		return new ORPCError("LOOP_INCOMPLETE", {
			status: 400,
			message: error.message,
			data: { missing: error.missing },
			cause: error,
		});
	}
	if (error instanceof LoopNameTakenError) {
		return new ORPCError("LOOP_NAME_TAKEN", {
			status: 409,
			message: error.message,
			data: { name: error.loopName },
			cause: error,
		});
	}
	if (error instanceof ComponentFromModuleError) {
		return new ORPCError("COMPONENT_FROM_MODULE", { status: 409, message: error.message, cause: error });
	}
	if (error instanceof FormNotFoundError) {
		return new ORPCError("FORM_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof FormInvalidError) {
		return new ORPCError("FORM_INVALID", {
			status: 400,
			message: error.message,
			data: { problems: error.problems },
			cause: error,
		});
	}
	if (error instanceof FormKeyTakenError) {
		return new ORPCError("FORM_KEY_TAKEN", {
			status: 409,
			message: error.message,
			data: { key: error.key },
			cause: error,
		});
	}
	if (error instanceof FormInUseError) {
		return new ORPCError("FORM_IN_USE", {
			status: 409,
			message: error.message,
			data: { usedIn: error.usedIn },
			cause: error,
		});
	}
	if (error instanceof CaptchaInvalidError) {
		return new ORPCError("CAPTCHA_INVALID", {
			status: 400,
			message: error.message,
			data: { problems: error.problems },
			cause: error,
		});
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
			data: { slug: error.slug, language: error.language },
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
	if (error instanceof PathTakenError) {
		return new ORPCError("PATH_TAKEN", {
			status: 409,
			message: error.message,
			data: { path: error.path, by: error.by },
			cause: error,
		});
	}
	if (error instanceof ArchiveUnavailableError) {
		return new ORPCError("ARCHIVE_UNAVAILABLE", {
			status: 409,
			message: error.message,
			data: { reason: error.reason },
			cause: error,
		});
	}
	if (error instanceof PagesHaveNoEntryTemplateError) {
		return new ORPCError("PAGES_HAVE_NO_ENTRY_TEMPLATE", { status: 400, message: error.message, cause: error });
	}
	if (error instanceof PageParentUnpublishedError) {
		return new ORPCError("PAGE_PARENT_UNPUBLISHED", { status: 409, message: error.message, cause: error });
	}
	if (error instanceof EntryLinkedError) {
		return new ORPCError("ENTRY_LINKED", {
			status: 409,
			message: error.message,
			data: { blockedBy: error.blockedBy },
			cause: error,
		});
	}
	if (error instanceof GlobalsInvalidError) {
		return new ORPCError("GLOBALS_INVALID", {
			status: 400,
			message: error.message,
			data: { problems: error.problems },
			cause: error,
		});
	}
	if (error instanceof GlobalsIncompleteError) {
		return new ORPCError("GLOBALS_INCOMPLETE", {
			status: 400,
			message: error.message,
			data: { missing: error.missing },
			cause: error,
		});
	}
	if (error instanceof LanguageInvalidError) {
		return new ORPCError("LANGUAGE_INVALID", {
			status: 400,
			message: error.message,
			data: { problems: error.problems },
			cause: error,
		});
	}
	if (error instanceof LanguageTakenError) {
		return new ORPCError("LANGUAGE_TAKEN", {
			status: 409,
			message: error.message,
			data: { field: error.field },
			cause: error,
		});
	}
	if (error instanceof DomainInvalidError) {
		return new ORPCError("DOMAIN_INVALID", {
			status: 400,
			message: error.message,
			data: { reason: error.reason },
			cause: error,
		});
	}
	if (error instanceof DomainTakenError) {
		return new ORPCError("DOMAIN_TAKEN", {
			status: 409,
			message: error.message,
			data: { name: error.domain },
			cause: error,
		});
	}
	if (error instanceof DomainNotFoundError) {
		return new ORPCError("DOMAIN_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof DomainChangeRefusedError) {
		return new ORPCError("DOMAIN_CHANGE_REFUSED", {
			status: 409,
			message: error.message,
			data: { problem: error.problem },
			cause: error,
		});
	}
	if (error instanceof LanguageNotFoundError) {
		return new ORPCError("LANGUAGE_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof ConfirmationInvalidError) {
		return new ORPCError("CONFIRMATION_INVALID", {
			status: 409,
			message: error.message,
			data: { problem: error.problem },
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
	if (error instanceof TemplateMarkupInvalidError) {
		return new ORPCError("TEMPLATE_MARKUP_INVALID", {
			status: 400,
			message: error.message,
			data: { problems: error.problems },
			cause: error,
		});
	}
	if (error instanceof DesignSystemInvalidError) {
		return new ORPCError("DESIGN_SYSTEM_INVALID", {
			status: 400,
			message: error.message,
			data: { problems: error.problems },
			cause: error,
		});
	}
	if (error instanceof ClassNotFoundError) {
		return new ORPCError("CLASS_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof ClassInUseError) {
		return new ORPCError("CLASS_IN_USE", {
			status: 409,
			message: error.message,
			data: { classId: error.classId, usedBy: error.usedBy },
			cause: error,
		});
	}
	if (error instanceof TokenInUseError) {
		return new ORPCError("TOKEN_IN_USE", {
			status: 409,
			message: error.message,
			data: { tokenId: error.tokenId, usedBy: error.usedBy },
			cause: error,
		});
	}
	if (error instanceof TokensFileInvalidError) {
		return new ORPCError("TOKENS_FILE_INVALID", {
			status: 400,
			message: error.message,
			data: { problems: error.problems },
			cause: error,
		});
	}
	if (error instanceof MediaNotFoundError) {
		return new ORPCError("MEDIA_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof MediaFolderNotFoundError) {
		return new ORPCError("MEDIA_FOLDER_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof MediaFolderTakenError) {
		return new ORPCError("MEDIA_FOLDER_TAKEN", { status: 409, message: error.message, cause: error });
	}
	if (error instanceof MediaTypeRefusedError) {
		return new ORPCError("MEDIA_TYPE_REFUSED", {
			status: 400,
			message: error.message,
			data: { reason: error.reason },
			cause: error,
		});
	}
	if (error instanceof MediaTooLargeError) {
		return new ORPCError("MEDIA_TOO_LARGE", {
			status: 413,
			message: error.message,
			data: { maxBytes: error.maxBytes },
			cause: error,
		});
	}
	if (error instanceof MediaInvalidError) {
		return new ORPCError("MEDIA_INVALID", {
			status: 400,
			message: error.message,
			data: { problems: error.problems },
			cause: error,
		});
	}
	if (error instanceof StorageUnreachableError) {
		return new ORPCError("STORAGE_UNREACHABLE", {
			status: 400,
			message: error.message,
			data: { problem: error.problem },
			cause: error,
		});
	}
	if (error instanceof HostInvalidError) {
		return new ORPCError("HOST_INVALID", {
			status: 400,
			message: error.message,
			data: { host: error.host },
			cause: error,
		});
	}
	if (error instanceof TooManyHostsError) {
		return new ORPCError("TOO_MANY_HOSTS", { status: 400, message: error.message, cause: error });
	}
	if (error instanceof SnippetInvalidError) {
		return new ORPCError("OUTSIDE_SCRIPT_INVALID", {
			status: 400,
			message: error.message,
			data: { problems: error.problems },
			cause: error,
		});
	}
	if (error instanceof OutsideScriptNotFoundError) {
		return new ORPCError("OUTSIDE_SCRIPT_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof LibraryNotFoundError) {
		return new ORPCError("LIBRARY_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof LibraryRefusedError) {
		return new ORPCError("LIBRARY_REFUSED", {
			status: 400,
			message: error.message,
			data: { problem: error.problem },
			cause: error,
		});
	}
	if (error instanceof ModuleError) {
		return new ORPCError("MODULE_ERROR", {
			status: error.status,
			message: error.message,
			data: { code: error.code },
			cause: error,
		});
	}
	if (error instanceof ModuleNotFoundError) {
		return new ORPCError("MODULE_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof ModuleChangedError) {
		return new ORPCError("MODULE_CHANGED", {
			status: 409,
			message: error.message,
			data: { version: error.version },
			cause: error,
		});
	}
	if (error instanceof ModuleCannotRunError) {
		return new ORPCError("MODULE_CANNOT_RUN", { status: 409, message: error.message, cause: error });
	}
	if (error instanceof ModuleNotApprovedError) {
		return new ORPCError("MODULE_NOT_APPROVED", { status: 409, message: error.message, cause: error });
	}
	if (error instanceof ModuleFailedError) {
		return new ORPCError("MODULE_FAILED", { status: 500, message: error.message, cause: error });
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
	if (error instanceof RateLimitedError) {
		return new ORPCError("TOO_MANY_REQUESTS", {
			status: 429,
			message: error.message,
			data: { retryAfterSeconds: error.retryAfterSeconds },
			cause: error,
		});
	}
	if (error instanceof AccountLockedError) {
		return new ORPCError("ACCOUNT_LOCKED", {
			status: 423,
			message: error.message,
			data: { retryAfterSeconds: error.retryAfterSeconds },
			cause: error,
		});
	}
	if (error instanceof EditFieldInvalidError) {
		return new ORPCError("EDIT_FIELD_INVALID", { status: 400, message: error.message, cause: error });
	}
	if (error instanceof EditModeUnavailableError) {
		return new ORPCError("EDIT_MODE_UNAVAILABLE", { status: 409, message: error.message, cause: error });
	}
	if (error instanceof DraftChangedError) {
		return new ORPCError("CHANGED_MEANWHILE", {
			status: 409,
			message: error.message,
			data: { version: error.version },
			cause: error,
		});
	}
	if (error instanceof CodeSourceNotFoundError) {
		return new ORPCError("CODE_SOURCE_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof EditPathInvalidError) {
		return new ORPCError("EDIT_PATH_INVALID", { status: 400, message: error.message, cause: error });
	}
	if (error instanceof InvalidCredentialsError) {
		return new ORPCError("INVALID_CREDENTIALS", { status: 401, message: error.message, cause: error });
	}
	if (isConcurrencyFailure(error)) {
		return new ORPCError("CHANGED_MEANWHILE", {
			status: 409,
			message: "Someone changed this at the same moment. Try again.",
			cause: error,
		});
	}
	return error;
}

/**
 * Whether Postgres gave up on a transaction because another one changed the same rows at the same
 * moment (a deadlock, or a serialization failure): nothing was saved, and trying again works.
 */
function isConcurrencyFailure(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; current && depth < 5; depth++) {
		const code = (current as { code?: unknown }).code;
		if (code === "40P01" || code === "40001") return true;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}
