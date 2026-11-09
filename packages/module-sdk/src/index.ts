/**
 * The Module SDK: the one package a Module may import from WebCraft (ADR 0024). A Module is a
 * workspace package (`modules/<id>`) that exports a `defineModule(…)`; WebCraft loads it, checks it
 * against its manifest, and gives it a `ModuleContext` wherever it runs.
 *
 * Besides its own types it hands Modules the tools to declare tables and queries (Drizzle's column
 * builders and comparison operators, but no raw SQL) and Zod for their inputs, so every Module uses
 * the versions WebCraft runs with.
 */
export {
	and,
	asc,
	count,
	countDistinct,
	desc,
	eq,
	gt,
	gte,
	ilike,
	inArray,
	isNotNull,
	isNull,
	like,
	lt,
	lte,
	max,
	min,
	ne,
	not,
	notInArray,
	or,
	type SQL,
	type SQLWrapper,
	sum,
} from "drizzle-orm";
export {
	bigint,
	boolean,
	date,
	doublePrecision,
	foreignKey,
	index,
	integer,
	jsonb,
	numeric,
	primaryKey,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
export { z } from "zod";
export { type AddressRange, addressInRanges, isAddressRange, parseAddress, parseAddressRange } from "./addresses.ts";
export {
	type ComponentProp,
	type ComponentPropType,
	component,
	type ModuleComponent,
} from "./component.ts";
export type {
	AggregateRow,
	ModuleConfirmations,
	ModuleContext,
	ModuleData,
	ModuleEmail,
	ModuleEmailMessage,
	ModuleEmailRecipient,
	ModuleHttpOptions,
	ModuleLog,
	ModulePlace,
	ModuleSecrets,
	ModuleSelectOptions,
	ModuleTable,
	NewModuleRow,
	ProcedureContext,
	SiteRouteContext,
	SiteVisitor,
	VisitorConsent,
} from "./context.ts";
export {
	type AdminPage,
	defineModule,
	job,
	MODULE_SITE_SCRIPT_MAX_LENGTH,
	type ModuleApi,
	type ModuleDefinition,
	type ModuleEventHandlers,
	type ModuleJob,
	type ModulePartitioning,
	type ModuleProcedure,
	type ModuleProcedures,
	type ModuleSiteScript,
	type ProcedureInput,
	procedure,
	type SiteRoute,
	siteRoute,
} from "./define.ts";
export { isModuleError, ModuleError, type ModuleRefusal, ModuleRefusedError } from "./errors.ts";
export {
	type FormSender,
	formSenderCounted,
	MODULE_EVENTS,
	type ModuleEvent,
	type ModuleEventName,
	type ModuleEvents,
} from "./events.ts";
export {
	IMPORT_FILE_MAX_BYTES,
	type ImportSource,
	importSource,
	type SourceEntry,
	type SourceFile,
	type SourceFileRef,
	type SourceItem,
	type SourceMedia,
	type SourceType,
	type SourceValue,
} from "./imports.ts";
export {
	CONSENT_CATEGORIES,
	type ConsentCategory,
	type Label,
	labelProblem,
	MODULE_ID,
	MODULE_PERMISSION_ROLES,
	MODULE_USES,
	type ModuleManifest,
	type ModuleManifestInput,
	type ModulePermissionRole,
	type ModuleUse,
	moduleManifestSchema,
	wordsIn,
} from "./manifest.ts";
export {
	type AddedRule,
	type ImportedRule,
	type ImportedRuleResult,
	type NotFoundLog,
	notFoundLog,
	type PageMiss,
	type RedirectRequest,
	type RedirectRules,
	type RedirectTarget,
	redirectRules,
} from "./redirects.ts";
export {
	AUTO_REPLY_WINDOW_HOURS,
	type FormSubmission,
	type KeptSubmission,
	type ModuleSchedule,
	type ModuleSubmissions,
	type SpamReason,
	type SubmissionDelivery,
	type SubmissionReceiver,
	type SubmissionValue,
	submissionReceiver,
} from "./submissions.ts";
export { type ModuleMigration, moduleSchema, moduleSchemaName, siteColumns, workspaceColumns } from "./tables.ts";
export { SDK_VERSION } from "./version.ts";
export {
	type ModuleWidget,
	WIDGET_FILTERS,
	WIDGET_SHAPES,
	type WidgetCell,
	type WidgetColumnKind,
	type WidgetData,
	type WidgetFilterName,
	type WidgetFilters,
	type WidgetOption,
	type WidgetRequest,
	type WidgetSetting,
	type WidgetSettings,
	type WidgetShape,
	widget,
} from "./widgets.ts";
