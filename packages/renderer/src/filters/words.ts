import type { FilterDatePreset } from "./version.ts";

/**
 * The words WebCraft itself writes into Filters, by language, where Staff leave a control's own words
 * empty: English, Italian, French, German, Spanish, Portuguese and Dutch, by the language's primary
 * subtag; English for any other. `{count}` is a number, `{label}` an option's label.
 */
export type FilterWords = {
	/** The Filter's name for screen readers. */
	filters: string;
	search: string;
	apply: string;
	reset: string;
	all: string;
	sort: string;
	sortDefault: string;
	from: string;
	to: string;
	activeFilters: string;
	/** A chip's name for screen readers: what pressing it does. */
	remove: string;
	showMore: string;
	one: string;
	other: string;
	none: string;
	/** The drawer's button applying its choices: `{results}` is how many items they list ("14 products"). */
	show: string;
	/** The drawer's Close button's name. */
	close: string;
	/** What follows how many choices a button's controls hold ("2 chosen"). */
	chosen: string;
	/** A range of days' presets. */
	presets: Readonly<Record<FilterDatePreset, string>>;
};

const WORDS: Readonly<Record<string, FilterWords>> = {
	en: {
		filters: "Filters",
		search: "Search",
		apply: "Apply",
		reset: "Reset",
		all: "All",
		sort: "Sort",
		sortDefault: "Default",
		from: "From",
		to: "To",
		activeFilters: "Active filters",
		remove: "Remove {label}",
		showMore: "Show more",
		one: "1 result",
		other: "{count} results",
		none: "No results",
		show: "Show {results}",
		close: "Close",
		chosen: "chosen",
		presets: {
			today: "Today",
			"next-7-days": "Next 7 days",
			"next-30-days": "Next 30 days",
			"this-month": "This month",
			"last-7-days": "Last 7 days",
			"last-30-days": "Last 30 days",
			"last-12-months": "Last 12 months",
			"this-year": "This year",
		},
	},
	it: {
		filters: "Filtri",
		search: "Cerca",
		apply: "Applica",
		reset: "Azzera",
		all: "Tutti",
		sort: "Ordina",
		sortDefault: "Predefinito",
		from: "Da",
		to: "A",
		activeFilters: "Filtri attivi",
		remove: "Rimuovi {label}",
		showMore: "Mostra altri",
		one: "1 risultato",
		other: "{count} risultati",
		none: "Nessun risultato",
		show: "Mostra {results}",
		close: "Chiudi",
		chosen: "scelti",
		presets: {
			today: "Oggi",
			"next-7-days": "Prossimi 7 giorni",
			"next-30-days": "Prossimi 30 giorni",
			"this-month": "Questo mese",
			"last-7-days": "Ultimi 7 giorni",
			"last-30-days": "Ultimi 30 giorni",
			"last-12-months": "Ultimi 12 mesi",
			"this-year": "Quest’anno",
		},
	},
	fr: {
		filters: "Filtres",
		search: "Rechercher",
		apply: "Appliquer",
		reset: "Réinitialiser",
		all: "Tous",
		sort: "Trier",
		sortDefault: "Par défaut",
		from: "De",
		to: "À",
		activeFilters: "Filtres actifs",
		remove: "Retirer {label}",
		showMore: "Afficher plus",
		one: "1 résultat",
		other: "{count} résultats",
		none: "Aucun résultat",
		show: "Afficher {results}",
		close: "Fermer",
		chosen: "choisis",
		presets: {
			today: "Aujourd’hui",
			"next-7-days": "7 prochains jours",
			"next-30-days": "30 prochains jours",
			"this-month": "Ce mois-ci",
			"last-7-days": "7 derniers jours",
			"last-30-days": "30 derniers jours",
			"last-12-months": "12 derniers mois",
			"this-year": "Cette année",
		},
	},
	de: {
		filters: "Filter",
		search: "Suchen",
		apply: "Anwenden",
		reset: "Zurücksetzen",
		all: "Alle",
		sort: "Sortieren",
		sortDefault: "Standard",
		from: "Von",
		to: "Bis",
		activeFilters: "Aktive Filter",
		remove: "{label} entfernen",
		showMore: "Mehr anzeigen",
		one: "1 Ergebnis",
		other: "{count} Ergebnisse",
		none: "Keine Ergebnisse",
		show: "{results} anzeigen",
		close: "Schließen",
		chosen: "ausgewählt",
		presets: {
			today: "Heute",
			"next-7-days": "Nächste 7 Tage",
			"next-30-days": "Nächste 30 Tage",
			"this-month": "Diesen Monat",
			"last-7-days": "Letzte 7 Tage",
			"last-30-days": "Letzte 30 Tage",
			"last-12-months": "Letzte 12 Monate",
			"this-year": "Dieses Jahr",
		},
	},
	es: {
		filters: "Filtros",
		search: "Buscar",
		apply: "Aplicar",
		reset: "Restablecer",
		all: "Todos",
		sort: "Ordenar",
		sortDefault: "Predeterminado",
		from: "Desde",
		to: "Hasta",
		activeFilters: "Filtros activos",
		remove: "Quitar {label}",
		showMore: "Mostrar más",
		one: "1 resultado",
		other: "{count} resultados",
		none: "Ningún resultado",
		show: "Mostrar {results}",
		close: "Cerrar",
		chosen: "elegidos",
		presets: {
			today: "Hoy",
			"next-7-days": "Próximos 7 días",
			"next-30-days": "Próximos 30 días",
			"this-month": "Este mes",
			"last-7-days": "Últimos 7 días",
			"last-30-days": "Últimos 30 días",
			"last-12-months": "Últimos 12 meses",
			"this-year": "Este año",
		},
	},
	pt: {
		filters: "Filtros",
		search: "Pesquisar",
		apply: "Aplicar",
		reset: "Repor",
		all: "Todos",
		sort: "Ordenar",
		sortDefault: "Predefinido",
		from: "De",
		to: "Até",
		activeFilters: "Filtros ativos",
		remove: "Remover {label}",
		showMore: "Mostrar mais",
		one: "1 resultado",
		other: "{count} resultados",
		none: "Nenhum resultado",
		show: "Mostrar {results}",
		close: "Fechar",
		chosen: "escolhidos",
		presets: {
			today: "Hoje",
			"next-7-days": "Próximos 7 dias",
			"next-30-days": "Próximos 30 dias",
			"this-month": "Este mês",
			"last-7-days": "Últimos 7 dias",
			"last-30-days": "Últimos 30 dias",
			"last-12-months": "Últimos 12 meses",
			"this-year": "Este ano",
		},
	},
	nl: {
		filters: "Filters",
		search: "Zoeken",
		apply: "Toepassen",
		reset: "Wissen",
		all: "Alle",
		sort: "Sorteren",
		sortDefault: "Standaard",
		from: "Van",
		to: "Tot",
		activeFilters: "Actieve filters",
		remove: "{label} verwijderen",
		showMore: "Meer tonen",
		one: "1 resultaat",
		other: "{count} resultaten",
		none: "Geen resultaten",
		show: "{results} tonen",
		close: "Sluiten",
		chosen: "gekozen",
		presets: {
			today: "Vandaag",
			"next-7-days": "Komende 7 dagen",
			"next-30-days": "Komende 30 dagen",
			"this-month": "Deze maand",
			"last-7-days": "Afgelopen 7 dagen",
			"last-30-days": "Afgelopen 30 dagen",
			"last-12-months": "Afgelopen 12 maanden",
			"this-year": "Dit jaar",
		},
	},
};

/** WebCraft's words for Filters in a language (English for one it has no words in). */
export function filterWords(language: string | undefined): FilterWords {
	const primary = (language ?? "en").split("-")[0]?.toLowerCase() ?? "en";
	return WORDS[primary] ?? (WORDS.en as FilterWords);
}
