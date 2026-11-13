import type { RANGE_PRESETS } from "../dashboards/model.ts";
import type { ReportLanguage } from "./model.ts";

/**
 * The words of Reports, their emails and Share link pages, in each language a Report can be in. A
 * missing word fails the typecheck. Placeholders are `{name}`, filled by `fill`.
 */
export type ReportWords = {
	/** The heading over a Report's days: "16 March 2026 – 22 March 2026". */
	period: string;
	comparedWith: string;
	whatHappened: string;
	suggestions: string;
	relatedService: string;
	writtenByAi: string;
	noAi: { noKey: string; cap: string; failed: string };
	/** A number compared with the one before. */
	change: { up: string; down: string; same: string; new: string };
	rateOf: string;
	noData: string;
	cantCount: string;
	sitesCounted: string;
	countedFrom: string;
	seriesSummary: string;
	seriesTotal: string;
	day: string;
	hour: string;
	/** The heading of a series' table column: its days, or its hours. */
	dayColumn: string;
	hourColumn: string;
	step: string;
	count: string;
	madeWith: string;
	reportFor: string;
	explore: {
		title: string;
		help: string;
		days: string;
		country: string;
		countryHelp: string;
		device: string;
		anyDevice: string;
		devices: { desktop: string; mobile: string; tablet: string };
		source: string;
		page: string;
		pageHelp: string;
		apply: string;
		reset: string;
	};
	ranges: Record<(typeof RANGE_PRESETS)[number], string>;
	password: {
		title: string;
		help: string;
		label: string;
		submit: string;
		wrong: string;
		tooMany: string;
		errorPrefix: string;
	};
	gone: { title: string; help: string };
	email: { subject: string; intro: string; attached: string; noAi: string; test: string };
	skipLink: string;
};

const en: ReportWords = {
	period: "{from} – {to}",
	comparedWith: "Compared with {from} – {to}",
	whatHappened: "What happened",
	suggestions: "Suggestions",
	relatedService: "Related service: {name}",
	writtenByAi: "Written by AI from the totals above. Check it before you rely on it.",
	noAi: {
		noKey: "This Report has no AI text: the Workspace has no AI key.",
		cap: "This Report has no AI text: this month's AI budget is used up.",
		failed: "This Report has no AI text: the AI provider didn't answer.",
	},
	change: {
		up: "Up {percent} on the period before ({previous})",
		down: "Down {percent} on the period before ({previous})",
		same: "The same as the period before",
		new: "None the period before",
	},
	rateOf: "{count} of {of}",
	noData: "Nothing was counted in these days.",
	cantCount: "This Widget can't count here: {reason}",
	sitesCounted: "Added up over {counted} of {of} Sites.",
	countedFrom: "Counts start on {day}: older visits are no longer kept.",
	seriesSummary: "{lines}, by {interval}, from {from} to {to}. Highest: {max}.",
	seriesTotal: "Total {label}: {total}",
	day: "day",
	hour: "hour",
	dayColumn: "Day",
	hourColumn: "Hour",
	step: "Step",
	count: "Count",
	madeWith: "Made with WebCraft",
	reportFor: "Report for {place}",
	explore: {
		title: "Explore",
		help: "Change the days and narrow the figures. Nothing you do here changes the Dashboard.",
		days: "Days",
		country: "Country",
		countryHelp: "Its two-letter code, such as IE.",
		device: "Device",
		anyDevice: "Any device",
		devices: { desktop: "Desktop", mobile: "Mobile", tablet: "Tablet" },
		source: "Source",
		page: "Page",
		pageHelp: "A path on the site, such as /contact; the pages under it count too.",
		apply: "Apply",
		reset: "Reset",
	},
	ranges: {
		today: "Today",
		yesterday: "Yesterday",
		last7Days: "Last 7 days",
		last30Days: "Last 30 days",
		last90Days: "Last 90 days",
		thisMonth: "This month",
		lastMonth: "Last month",
		last12Months: "Last 12 months",
	},
	password: {
		title: "This Dashboard is protected",
		help: "Give the password you were sent with the link to see it.",
		label: "Password",
		submit: "Open",
		wrong: "That isn't the password. Try again.",
		tooMany: "Too many tries. Wait a minute, then try again.",
		errorPrefix: "Error:",
	},
	gone: {
		title: "This link doesn't work",
		help: "It may have expired or been turned off. Ask whoever sent it for a new one.",
	},
	email: {
		subject: "{name}: {period}",
		intro: "Here is {name} for {place}, covering {period}.",
		attached: "The full Report is attached as a PDF.",
		noAi: "This Report has no AI text this time.",
		test: "This is a test: only you were sent it.",
	},
	skipLink: "Skip to the figures",
};

const it: ReportWords = {
	period: "{from} – {to}",
	comparedWith: "Rispetto a {from} – {to}",
	whatHappened: "Cosa è successo",
	suggestions: "Suggerimenti",
	relatedService: "Servizio correlato: {name}",
	writtenByAi: "Scritto dall'IA a partire dai totali qui sopra. Verificatelo prima di farci affidamento.",
	noAi: {
		noKey: "Questo report non ha testo dell'IA: lo spazio di lavoro non ha una chiave IA.",
		cap: "Questo report non ha testo dell'IA: il budget IA di questo mese è esaurito.",
		failed: "Questo report non ha testo dell'IA: il fornitore di IA non ha risposto.",
	},
	change: {
		up: "In aumento del {percent} rispetto al periodo precedente ({previous})",
		down: "In calo del {percent} rispetto al periodo precedente ({previous})",
		same: "Uguale al periodo precedente",
		new: "Nessuno nel periodo precedente",
	},
	rateOf: "{count} su {of}",
	noData: "In questi giorni non è stato contato nulla.",
	cantCount: "Questo widget non può contare qui: {reason}",
	sitesCounted: "Sommato su {counted} di {of} siti.",
	countedFrom: "I conteggi partono dal {day}: le visite più vecchie non sono più conservate.",
	seriesSummary: "{lines}, per {interval}, dal {from} al {to}. Massimo: {max}.",
	seriesTotal: "Totale {label}: {total}",
	day: "giorno",
	hour: "ora",
	dayColumn: "Giorno",
	hourColumn: "Ora",
	step: "Passo",
	count: "Numero",
	madeWith: "Creato con WebCraft",
	reportFor: "Report per {place}",
	explore: {
		title: "Esplora",
		help: "Cambiate i giorni e restringete i dati. Nulla di ciò che fate qui modifica la dashboard.",
		days: "Giorni",
		country: "Paese",
		countryHelp: "Il suo codice di due lettere, come IT.",
		device: "Dispositivo",
		anyDevice: "Qualsiasi dispositivo",
		devices: { desktop: "Computer", mobile: "Telefono", tablet: "Tablet" },
		source: "Sorgente",
		page: "Pagina",
		pageHelp: "Un percorso del sito, come /contatti; contano anche le pagine sotto di esso.",
		apply: "Applica",
		reset: "Azzera",
	},
	ranges: {
		today: "Oggi",
		yesterday: "Ieri",
		last7Days: "Ultimi 7 giorni",
		last30Days: "Ultimi 30 giorni",
		last90Days: "Ultimi 90 giorni",
		thisMonth: "Questo mese",
		lastMonth: "Mese scorso",
		last12Months: "Ultimi 12 mesi",
	},
	password: {
		title: "Questa dashboard è protetta",
		help: "Inserite la password che avete ricevuto con il link per vederla.",
		label: "Password",
		submit: "Apri",
		wrong: "La password non è corretta. Riprovate.",
		tooMany: "Troppi tentativi. Aspettate un minuto, poi riprovate.",
		errorPrefix: "Errore:",
	},
	gone: {
		title: "Questo link non funziona",
		help: "Potrebbe essere scaduto o disattivato. Chiedetene uno nuovo a chi ve l'ha inviato.",
	},
	email: {
		subject: "{name}: {period}",
		intro: "Ecco {name} per {place}, relativo a {period}.",
		attached: "Il report completo è allegato in PDF.",
		noAi: "Questa volta il report non ha testo dell'IA.",
		test: "Questa è una prova: è stata inviata solo a voi.",
	},
	skipLink: "Vai ai dati",
};

const WORDS: Record<ReportLanguage, ReportWords> = { en, it };

export function reportWords(language: string): ReportWords {
	return WORDS[language as ReportLanguage] ?? en;
}

/** Fills `{name}` placeholders. */
export function fill(text: string, values: Record<string, string | number>): string {
	return text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole));
}

/** The locale a language's dates and numbers are written in: British English for English, as WebCraft writes. */
function localeOf(language: string): string {
	return language === "en" ? "en-GB" : language;
}

/** A day as people read it in the language, such as "16 March 2026" (UTC). */
export function dayText(at: Date, language: string): string {
	return new Intl.DateTimeFormat(localeOf(language), {
		day: "numeric",
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	}).format(at);
}

/** A period's days, the last one counted: "16 March 2026 – 22 March 2026". */
export function periodText(from: Date, to: Date, language: string): string {
	const last = new Date(to.getTime() - 24 * 60 * 60 * 1000);
	return fill(reportWords(language).period, { from: dayText(from, language), to: dayText(last, language) });
}

/** A whole number as people read it in the language. */
export function numberText(value: number, language: string): string {
	return new Intl.NumberFormat(localeOf(language)).format(value);
}

/** A share as a percentage, such as "12.5%". */
export function percentText(part: number, whole: number, language: string): string {
	return new Intl.NumberFormat(localeOf(language), { style: "percent", maximumFractionDigits: 1 }).format(
		whole === 0 ? 0 : part / whole,
	);
}
