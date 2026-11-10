/**
 * Reports, Share links and their branding (#104, GLOSSARY.md): a Dashboard sent as a PDF on a
 * schedule (`service.ts`, its jobs in `jobs.ts`), opened by anyone holding a link (`share-links.ts`),
 * both shown by one page (`page.ts`) under the agency's and the client's brand (`branding.ts`), with
 * AI text built from totals only (`ai.ts`) whose suggestions may point to the Services list
 * (`services-list.ts`).
 */
export type { ReportAiText } from "./ai.ts";
export {
	type AgencyBrandInput,
	type AgencyBrandView,
	type InstallBrandingInput,
	type InstallBrandingView,
	installBranding,
	LOGO_MAX_BYTES,
	type LogoInput,
	type LogoView,
	type SiteBrandingInput,
	type SiteBrandingView,
	siteBranding,
	updateInstallBranding,
	updateSiteBranding,
	updateWorkspaceBranding,
	type WorkspaceBrandingInput,
	type WorkspaceBrandingView,
	workspaceBranding,
} from "./branding.ts";
export * from "./errors.ts";
export {
	reportsDue,
	reportsDueSchedule,
	reportsPrepare,
	reportsPurge,
	reportsPurgeSchedule,
	reportsRender,
} from "./jobs.ts";
export {
	AI_TEXT_LIMITS,
	MAX_RECIPIENTS,
	MAX_REPORTS_PER_DASHBOARD,
	nextRunAfter,
	periodBefore,
	REPORT_HISTORY_DAYS,
	REPORT_LANGUAGES,
	REPORT_SCHEDULES,
	type ReportLanguage,
	type ReportSchedule,
	SHARE_LINK_LABEL,
} from "./model.ts";
export {
	REPORT_PAGE_POLICY,
	type ReportBrand,
	type ReportExplore,
	reportPage,
	shareGonePage,
	sharePasswordPage,
} from "./page.ts";
export { PDF_LIMITS, type PdfProblem, PdfRenderError, type PdfRenderer, pdfOnlyInWorker } from "./pdf.ts";
export {
	createReports,
	openPlace,
	type ReportInput,
	type ReportRecipientStatus,
	type ReportSendDetail,
	type ReportSendRef,
	type ReportSendView,
	type Reports,
	type ReportView,
} from "./service.ts";
export { MAX_SERVICES, type Service, saveServicesList, servicesList } from "./services-list.ts";
export {
	createShareLinks,
	MAX_SHARE_LINKS,
	type OpenShareLink,
	SHARE_LINK_PASSWORD,
	type ShareLinkInput,
	type ShareLinks,
	type ShareLinkView,
} from "./share-links.ts";
export { reportWords } from "./words.ts";
