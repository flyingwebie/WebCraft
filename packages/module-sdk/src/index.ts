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
	ne,
	not,
	notInArray,
	or,
	type SQL,
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
export {
	type ComponentProp,
	type ComponentPropType,
	component,
	type ModuleComponent,
} from "./component.ts";
export type {
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
} from "./context.ts";
export {
	type AdminPage,
	defineModule,
	job,
	type ModuleApi,
	type ModuleDefinition,
	type ModuleEventHandlers,
	type ModuleJob,
	type ModuleProcedure,
	type ModuleProcedures,
	type ProcedureInput,
	procedure,
	type SiteRoute,
	siteRoute,
} from "./define.ts";
export { ModuleError, type ModuleRefusal, ModuleRefusedError } from "./errors.ts";
export { MODULE_EVENTS, type ModuleEvent, type ModuleEventName, type ModuleEvents } from "./events.ts";
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
	type FormSubmission,
	type ModuleSchedule,
	type SpamReason,
	type SubmissionReceiver,
	type SubmissionValue,
	submissionReceiver,
} from "./submissions.ts";
export { type ModuleMigration, moduleSchema, moduleSchemaName, siteColumns, workspaceColumns } from "./tables.ts";
export { SDK_VERSION } from "./version.ts";
