import { ORPCError } from "@orpc/server";
import {
	AccountLockedError,
	AuthenticatorExistsError,
	EmailInUseError,
	InvalidCredentialsError,
	InvalidEmailError,
	PasskeyInvalidError,
	PasswordRefusedError,
	SecondFactorNotFoundError,
	SignInExpiredError,
	TwoFactorCodeInvalidError,
	TwoFactorOffError,
} from "@webcraft/auth";
import {
	AccessNotHeldError,
	AiCapReachedError,
	AiKeyInvalidError,
	AiKeyMissingError,
	AiProviderError,
	AlreadyMemberError,
	AltTextUnavailableError,
	ApiTokenNotFoundError,
	ArchiveUnavailableError,
	BrandingInvalidError,
	CaptchaInvalidError,
	CheckpointNotFoundError,
	ClassInUseError,
	ClassNotFoundError,
	CodeSourceNotFoundError,
	ComponentFromModuleError,
	ComponentInUseError,
	ComponentInvalidError,
	ComponentNameTakenError,
	ComponentNotFoundError,
	ConfirmationInvalidError,
	ConsentBannerInvalidError,
	ConsentRecordNotFoundError,
	ContentApiInvalidError,
	ContentKeyNotFoundError,
	CsvRefusedError,
	DashboardInvalidError,
	DashboardNotFoundError,
	DashboardTemplateNotFoundError,
	DeviceCodeInvalidError,
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
	FilterInvalidError,
	FilterNameTakenError,
	FilterNotFoundError,
	FormInUseError,
	FormInvalidError,
	FormKeyTakenError,
	FormNotFoundError,
	GlobalsIncompleteError,
	GlobalsInvalidError,
	HomePageUnpublishError,
	HostInvalidError,
	IdentityCheckRequiredError,
	ImpersonationNeedsSecondFactorError,
	ImpersonationRefusedError,
	ImportFileNotFoundError,
	ImportFileNotReadyError,
	ImportInvalidError,
	ImportNotFoundError,
	ImportPostTypeFixedError,
	ImportRunNotFoundError,
	ImportRunningError,
	ImportSourceNotFoundError,
	ImportUndoRefusedError,
	ImportUploadRefusedError,
	InviteForAnotherAccountError,
	InviteInvalidError,
	ItemAlreadyScheduledError,
	ItemInReviewError,
	LanguageInvalidError,
	LanguageNotFoundError,
	LanguageTakenError,
	LibraryNotFoundError,
	LibraryRefusedError,
	LoopIncompleteError,
	LoopInvalidError,
	LoopItemRestoreRefusedError,
	LoopNameTakenError,
	LoopNotFoundError,
	MediaFolderNotFoundError,
	MediaFolderTakenError,
	MediaImportRefusedError,
	MediaInTrashError,
	MediaInvalidError,
	MediaNotFoundError,
	MediaNotInTrashError,
	MediaQuotaFullError,
	MediaReplaceRefusedError,
	MediaTooLargeError,
	MediaTypeRefusedError,
	MemberNotFoundError,
	ModuleCannotRunError,
	ModuleChangedError,
	ModuleFailedError,
	ModuleNotApprovedError,
	ModuleNotFoundError,
	NotWhileImpersonatingError,
	OAuthGrantNotFoundError,
	OAuthRequestError,
	OutsideScriptNotFoundError,
	PageHasChildrenError,
	PageNotFoundError,
	PageParentUnpublishedError,
	PagesHaveNoEntryTemplateError,
	PathTakenError,
	PermissionDeniedError,
	PersonNotFoundError,
	PostTypeInvalidError,
	PostTypeNotFoundError,
	PostTypeTakenError,
	ProtectedTermInvalidError,
	ProtectedTermNotFoundError,
	PublishAllInvalidError,
	PublishAllRefusedError,
	RateLimitedError,
	ReportInvalidError,
	ReportNotFoundError,
	ReportSendNotFoundError,
	ReportSendRefusedError,
	ReviewDecidedError,
	ReviewInvalidError,
	ReviewNotFoundError,
	ReviewNotYoursError,
	RevisionNotFoundError,
	ScheduledPublishNotFoundError,
	ScheduleInvalidError,
	ScriptNotFoundError,
	SensitiveActionRefusedError,
	SeoSettingsInvalidError,
	ServicesListInvalidError,
	SessionNotFoundError,
	SetupClosedError,
	SetupStageError,
	SetupTokenInvalidError,
	SharedAiKeyNotFoundError,
	ShareLinkInvalidError,
	ShareLinkNotFoundError,
	ShareLinksUnavailableError,
	SiteNotFoundError,
	SlugInvalidError,
	SlugTakenError,
	SmtpPasswordNeededError,
	SnippetInvalidError,
	StaffMembershipError,
	StaffNotFoundError,
	StagingPasswordInvalidError,
	StagingUnavailableError,
	StorageUnreachableError,
	TemplateNotFoundError,
	TokenInUseError,
	TokensFileInvalidError,
	ToolsetUnknownError,
	TooManyHostsError,
	TooManyWebhooksError,
	TranslationLanguageError,
	TranslationNotFoundError,
	TwoFactorRequiredError,
	TwoFactorSetupRequiredError,
	WebhookDeliveryNotFoundError,
	WebhookInvalidError,
	WebhookNotFoundError,
	WebhookRedeliveryRefusedError,
	WidgetNotFoundError,
	WorkspaceNotFoundError,
} from "@webcraft/core";
import { isModuleError } from "@webcraft/module-sdk";
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
	if (error instanceof RevisionNotFoundError) {
		return new ORPCError("REVISION_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof CheckpointNotFoundError) {
		return new ORPCError("CHECKPOINT_NOT_FOUND", { status: 404, message: error.message, cause: error });
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
	if (error instanceof FilterNotFoundError) {
		return new ORPCError("FILTER_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof FilterInvalidError) {
		return new ORPCError("FILTER_INVALID", {
			status: 400,
			message: error.message,
			data: { problems: error.problems },
			cause: error,
		});
	}
	if (error instanceof FilterNameTakenError) {
		return new ORPCError("FILTER_NAME_TAKEN", {
			status: 409,
			message: error.message,
			data: { name: error.filterName },
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
	if (error instanceof ConsentBannerInvalidError) {
		return new ORPCError("CONSENT_BANNER_INVALID", {
			status: 400,
			message: error.message,
			data: { problems: error.problems },
			cause: error,
		});
	}
	if (error instanceof SeoSettingsInvalidError) {
		return new ORPCError("SEO_SETTINGS_INVALID", {
			status: 400,
			message: error.message,
			data: { problems: error.problems },
			cause: error,
		});
	}
	if (error instanceof ContentApiInvalidError) {
		return new ORPCError("CONTENT_API_INVALID", {
			status: 400,
			message: error.message,
			data: { problems: error.problems },
			cause: error,
		});
	}
	if (error instanceof ContentKeyNotFoundError) {
		return new ORPCError("CONTENT_KEY_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof ConsentRecordNotFoundError) {
		return new ORPCError("CONSENT_RECORD_NOT_FOUND", { status: 404, message: error.message, cause: error });
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
	if (error instanceof HomePageUnpublishError) {
		return new ORPCError("HOME_PAGE_UNPUBLISH", { status: 409, message: error.message, cause: error });
	}
	if (error instanceof ScheduleInvalidError) {
		return new ORPCError("SCHEDULE_INVALID", {
			status: 400,
			message: error.message,
			data: { reason: error.reason },
			cause: error,
		});
	}
	if (error instanceof ItemAlreadyScheduledError) {
		return new ORPCError("ALREADY_SCHEDULED", {
			status: 409,
			message: error.message,
			data: { item: error.item, scheduleId: error.scheduleId, at: error.at.toISOString() },
			cause: error,
		});
	}
	if (error instanceof ReviewInvalidError) {
		return new ORPCError("REVIEW_INVALID", {
			status: 400,
			message: error.message,
			data: { reason: error.reason, item: error.item },
			cause: error,
		});
	}
	if (error instanceof ItemInReviewError) {
		return new ORPCError("ALREADY_IN_REVIEW", {
			status: 409,
			message: error.message,
			data: { item: error.item, reviewId: error.reviewId },
			cause: error,
		});
	}
	if (error instanceof ReviewNotFoundError) {
		return new ORPCError("REVIEW_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof ReviewDecidedError) {
		return new ORPCError("REVIEW_DECIDED", {
			status: 409,
			message: error.message,
			data: { status: error.status },
			cause: error,
		});
	}
	if (error instanceof ReviewNotYoursError) {
		return new ORPCError("REVIEW_NOT_YOURS", { status: 403, message: error.message, cause: error });
	}
	if (error instanceof ScheduledPublishNotFoundError) {
		return new ORPCError("SCHEDULED_PUBLISH_NOT_FOUND", { status: 404, message: error.message, cause: error });
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
	if (error instanceof DashboardNotFoundError) {
		return new ORPCError("DASHBOARD_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof WidgetNotFoundError) {
		return new ORPCError("WIDGET_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof DashboardTemplateNotFoundError) {
		return new ORPCError("DASHBOARD_TEMPLATE_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof DashboardInvalidError) {
		return new ORPCError("DASHBOARD_INVALID", {
			status: 400,
			message: error.message,
			data: { problem: error.problem },
			cause: error,
		});
	}
	if (error instanceof ReportNotFoundError) {
		return new ORPCError("REPORT_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof ReportInvalidError) {
		return new ORPCError("REPORT_INVALID", {
			status: 400,
			message: error.message,
			data: { field: error.field },
			cause: error,
		});
	}
	if (error instanceof ReportSendNotFoundError) {
		return new ORPCError("REPORT_SEND_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof ReportSendRefusedError) {
		return new ORPCError("REPORT_SEND_REFUSED", {
			status: 409,
			message: error.message,
			data: { reason: error.reason },
			cause: error,
		});
	}
	if (error instanceof ShareLinkNotFoundError) {
		return new ORPCError("SHARE_LINK_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof ShareLinkInvalidError) {
		return new ORPCError("SHARE_LINK_INVALID", {
			status: 400,
			message: error.message,
			data: { field: error.field },
			cause: error,
		});
	}
	if (error instanceof ShareLinksUnavailableError) {
		return new ORPCError("SHARE_LINKS_UNAVAILABLE", { status: 409, message: error.message, cause: error });
	}
	if (error instanceof BrandingInvalidError) {
		return new ORPCError("BRANDING_INVALID", {
			status: 400,
			message: error.message,
			data: { field: error.field },
			cause: error,
		});
	}
	if (error instanceof ServicesListInvalidError) {
		return new ORPCError("SERVICES_LIST_INVALID", { status: 400, message: error.message, cause: error });
	}
	if (error instanceof WebhookInvalidError) {
		return new ORPCError("WEBHOOK_INVALID", {
			status: 400,
			message: error.message,
			data: { field: error.field, reason: error.reason },
			cause: error,
		});
	}
	if (error instanceof WebhookNotFoundError) {
		return new ORPCError("WEBHOOK_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof TooManyWebhooksError) {
		return new ORPCError("TOO_MANY_WEBHOOKS", {
			status: 409,
			message: error.message,
			data: { max: error.max },
			cause: error,
		});
	}
	if (error instanceof WebhookDeliveryNotFoundError) {
		return new ORPCError("WEBHOOK_DELIVERY_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof WebhookRedeliveryRefusedError) {
		return new ORPCError("WEBHOOK_REDELIVERY_REFUSED", {
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
	if (error instanceof CsvRefusedError) {
		return new ORPCError("IMPORT_FILE_REFUSED", {
			status: error.reason === "size" ? 413 : 400,
			message: error.message,
			data: { reason: error.reason, ...error.params },
			cause: error,
		});
	}
	if (error instanceof ImportFileNotFoundError) {
		return new ORPCError("IMPORT_FILE_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof ImportFileNotReadyError) {
		return new ORPCError("IMPORT_FILE_NOT_READY", {
			status: 409,
			message: error.message,
			data: { status: error.status },
			cause: error,
		});
	}
	if (error instanceof ImportSourceNotFoundError) {
		return new ORPCError("IMPORT_SOURCE_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof ImportUploadRefusedError) {
		return new ORPCError("IMPORT_UPLOAD_REFUSED", {
			status: error.reason === "size" && "maxBytes" in error.details ? 413 : error.reason === "status" ? 409 : 400,
			message: error.message,
			data: { reason: error.reason, ...error.details },
			cause: error,
		});
	}
	if (error instanceof ImportNotFoundError) {
		return new ORPCError("IMPORT_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof ImportRunNotFoundError) {
		return new ORPCError("IMPORT_RUN_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof ImportInvalidError) {
		return new ORPCError("IMPORT_INVALID", {
			status: 400,
			message: error.message,
			data: { problems: error.problems },
			cause: error,
		});
	}
	if (error instanceof ImportPostTypeFixedError) {
		return new ORPCError("IMPORT_POST_TYPE_FIXED", { status: 409, message: error.message, cause: error });
	}
	if (error instanceof ImportRunningError) {
		return new ORPCError("IMPORT_RUNNING", {
			status: 409,
			message: error.message,
			data: { runId: error.runId },
			cause: error,
		});
	}
	if (error instanceof ImportUndoRefusedError) {
		return new ORPCError("IMPORT_UNDO_REFUSED", {
			status: 409,
			message: error.message,
			data: { reason: error.reason, entries: error.entries },
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
	if (error instanceof TranslationLanguageError) {
		return new ORPCError("TRANSLATION_LANGUAGE_INVALID", {
			status: 400,
			message: error.message,
			data: { reason: error.reason },
			cause: error,
		});
	}
	if (error instanceof TranslationNotFoundError) {
		return new ORPCError("TRANSLATION_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof ProtectedTermInvalidError) {
		return new ORPCError("PROTECTED_TERM_INVALID", {
			status: 400,
			message: error.message,
			data: { index: error.index, reason: error.reason },
			cause: error,
		});
	}
	if (error instanceof ProtectedTermNotFoundError) {
		return new ORPCError("PROTECTED_TERM_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof AiKeyInvalidError) {
		return new ORPCError("AI_KEY_INVALID", {
			status: 400,
			message: error.message,
			data: { field: error.field, reason: error.reason },
			cause: error,
		});
	}
	if (error instanceof AiCapReachedError) {
		return new ORPCError("AI_CAP_REACHED", {
			status: 409,
			message: error.message,
			data: { key: error.key, resumesAt: error.resumesAt.toISOString() },
			cause: error,
		});
	}
	if (error instanceof SharedAiKeyNotFoundError) {
		return new ORPCError("SHARED_AI_KEY_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof AiKeyMissingError) {
		return new ORPCError("AI_KEY_MISSING", { status: 409, message: error.message, cause: error });
	}
	if (error instanceof AiProviderError) {
		return new ORPCError("AI_PROVIDER_FAILED", {
			status: 424,
			message: error.message,
			data: { problem: error.problem },
			cause: error,
		});
	}
	if (error instanceof AltTextUnavailableError) {
		return new ORPCError("ALT_TEXT_UNAVAILABLE", {
			status: 400,
			message: error.message,
			data: { reason: error.reason },
			cause: error,
		});
	}
	if (error instanceof MediaImportRefusedError) {
		return new ORPCError("MEDIA_IMPORT_REFUSED", {
			status: 400,
			message: error.message,
			data: { problem: error.problem, ...(error.status === undefined ? {} : { status: error.status }) },
			cause: error,
		});
	}
	if (error instanceof MediaInTrashError) {
		return new ORPCError("MEDIA_IN_TRASH", { status: 409, message: error.message, cause: error });
	}
	if (error instanceof MediaNotInTrashError) {
		return new ORPCError("MEDIA_NOT_IN_TRASH", { status: 409, message: error.message, cause: error });
	}
	if (error instanceof MediaReplaceRefusedError) {
		return new ORPCError("MEDIA_REPLACE_REFUSED", {
			status: 400,
			message: error.message,
			data: { reason: error.reason },
			cause: error,
		});
	}
	if (error instanceof MediaQuotaFullError) {
		return new ORPCError("MEDIA_QUOTA_FULL", {
			status: 413,
			message: error.message,
			data: { usedBytes: error.usedBytes, quotaBytes: error.quotaBytes },
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
	if (isModuleError(error)) {
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
	if (error instanceof ApiTokenNotFoundError) {
		return new ORPCError("API_TOKEN_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof DeviceCodeInvalidError) {
		return new ORPCError("DEVICE_CODE_INVALID", {
			status: 400,
			message: error.message,
			data: { problem: error.problem },
			cause: error,
		});
	}
	if (error instanceof OAuthGrantNotFoundError) {
		return new ORPCError("AI_CLIENT_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof ToolsetUnknownError) {
		return new ORPCError("TOOLSET_UNKNOWN", {
			status: 400,
			message: error.message,
			data: { toolset: error.toolset },
			cause: error,
		});
	}
	if (error instanceof OAuthRequestError) {
		return new ORPCError("AUTHORIZATION_REQUEST_INVALID", {
			status: error.status,
			message: error.message,
			data: { error: error.error },
			cause: error,
		});
	}
	if (error instanceof NotWhileImpersonatingError) {
		return new ORPCError("NOT_WHILE_IMPERSONATING", {
			status: 403,
			message: error.message,
			data: { what: error.what },
			cause: error,
		});
	}
	if (error instanceof ImpersonationRefusedError) {
		return new ORPCError("IMPERSONATION_REFUSED", {
			status: 403,
			message: error.message,
			data: { reason: error.reason },
			cause: error,
		});
	}
	if (error instanceof ImpersonationNeedsSecondFactorError) {
		return new ORPCError("TWO_FACTOR_OFF", {
			status: 409,
			message: error.message,
			data: { for: "impersonation" },
			cause: error,
		});
	}
	if (error instanceof PersonNotFoundError) {
		return new ORPCError("PERSON_NOT_FOUND", { status: 404, message: error.message, cause: error });
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
	if (error instanceof SmtpPasswordNeededError) {
		return new ORPCError("SMTP_PASSWORD_NEEDED", { status: 400, message: error.message, cause: error });
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
	if (error instanceof TwoFactorCodeInvalidError) {
		return new ORPCError("TWO_FACTOR_CODE_INVALID", {
			// While setting up an app a wrong code is a mistake to correct; elsewhere it is a refused sign-in.
			status: error.during === "setup" ? 400 : 401,
			message: error.message,
			cause: error,
		});
	}
	if (error instanceof PasskeyInvalidError) {
		return new ORPCError("PASSKEY_INVALID", {
			status: error.during === "setup" ? 400 : 401,
			message: error.message,
			cause: error,
		});
	}
	if (error instanceof SignInExpiredError) {
		return new ORPCError("SIGN_IN_EXPIRED", { status: 401, message: error.message, cause: error });
	}
	if (error instanceof AuthenticatorExistsError) {
		return new ORPCError("AUTHENTICATOR_EXISTS", { status: 409, message: error.message, cause: error });
	}
	if (error instanceof SecondFactorNotFoundError) {
		return new ORPCError("TWO_FACTOR_NOT_FOUND", { status: 404, message: error.message, cause: error });
	}
	if (error instanceof TwoFactorOffError) {
		return new ORPCError("TWO_FACTOR_OFF", { status: 409, message: error.message, cause: error });
	}
	if (error instanceof TwoFactorRequiredError) {
		return new ORPCError("TWO_FACTOR_REQUIRED", { status: 409, message: error.message, cause: error });
	}
	if (error instanceof TwoFactorSetupRequiredError) {
		return new ORPCError("TWO_FACTOR_SETUP_REQUIRED", { status: 403, message: error.message, cause: error });
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
	if (error instanceof LoopItemRestoreRefusedError) {
		return new ORPCError("LOOP_ITEM_RESTORE_REFUSED", { status: 403, message: error.message, cause: error });
	}
	if (error instanceof PublishAllInvalidError) {
		return new ORPCError("PUBLISH_ALL_INVALID", {
			status: 400,
			message: error.message,
			data: { items: error.items },
			cause: error,
		});
	}
	if (error instanceof PublishAllRefusedError) {
		// Why the item can't be published, as publishing it alone would say; nothing was published.
		const reason = toApiError(error.cause);
		if (!(reason instanceof ORPCError)) return reason;
		return new ORPCError("PUBLISH_ALL_REFUSED", {
			status: 409,
			message: `${error.message} ${reason.message}`,
			data: { item: error.item, name: error.itemName, code: reason.code, data: reason.data ?? null },
			cause: error,
		});
	}
	if (error instanceof StagingUnavailableError) {
		return new ORPCError("STAGING_UNAVAILABLE", { status: 409, message: error.message, cause: error });
	}
	if (error instanceof StagingPasswordInvalidError) {
		return new ORPCError("STAGING_PASSWORD_INVALID", { status: 400, message: error.message, cause: error });
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
