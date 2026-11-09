/**
 * The Consent banner's words. Each is Content (ADR 0020): people write it per language in the
 * banner's Draft; a word nobody wrote shows WebCraft's own, in the page's language (English, Italian,
 * French, German, Spanish, Portuguese or Dutch, by its primary subtag; English for any other).
 */

/** The words of the banner people can write, in the order the admin shows them. */
export const CONSENT_TEXT_KEYS = [
	"heading",
	"message",
	"acceptAll",
	"rejectAll",
	"choose",
	"save",
	"settings",
	"privacyPolicy",
	"necessary",
	"necessaryText",
	"analytics",
	"analyticsText",
	"marketing",
	"marketingText",
	"media",
	"mediaText",
	"embedText",
	"loadContent",
	"rememberEmbeds",
] as const;

export type ConsentTextKey = (typeof CONSENT_TEXT_KEYS)[number];

/**
 * Every word a banner shows: the heading and message; its buttons; the "Cookie settings" button that
 * opens it again (`settings`); the privacy policy link's text when the link gives none; each Consent
 * category's name and what it is for; what a held-back embed's placeholder says. `categories` names
 * the list of categories for screen readers, and is WebCraft's own.
 */
export type ConsentWords = Record<ConsentTextKey, string> & { categories: string };

const CONSENT_WORDS: Readonly<Record<string, ConsentWords>> = {
	en: {
		heading: "Privacy choices",
		message:
			"We'd like to use cookies and similar tools for analytics, marketing and content from other sites, such as videos. Choose what you accept. You can change your mind at any time with “Cookie settings”.",
		acceptAll: "Accept all",
		rejectAll: "Reject all",
		choose: "Choose",
		save: "Save choices",
		settings: "Cookie settings",
		privacyPolicy: "Privacy policy",
		necessary: "Necessary",
		necessaryText: "Keeps the site working, such as remembering these choices. Always on.",
		analytics: "Analytics",
		analyticsText: "Counts visits and shows how the site is used.",
		marketing: "Marketing",
		marketingText: "Measures and personalises advertising.",
		media: "Media",
		mediaText: "Shows content from other sites, such as videos and maps.",
		embedText: "This content comes from another site, which may set cookies or learn about your visit.",
		loadContent: "Load content",
		rememberEmbeds: "Always load Media content",
		categories: "Categories",
	},
	it: {
		heading: "Le tue scelte sulla privacy",
		message:
			"Vorremmo usare cookie e strumenti simili per statistiche, marketing e contenuti di altri siti, come i video. Scegli cosa accetti. Puoi cambiare idea in qualsiasi momento con “Impostazioni dei cookie”.",
		acceptAll: "Accetta tutto",
		rejectAll: "Rifiuta tutto",
		choose: "Scegli",
		save: "Salva le scelte",
		settings: "Impostazioni dei cookie",
		privacyPolicy: "Informativa sulla privacy",
		necessary: "Necessari",
		necessaryText: "Fanno funzionare il sito, ad esempio ricordando queste scelte. Sempre attivi.",
		analytics: "Statistiche",
		analyticsText: "Contano le visite e mostrano come viene usato il sito.",
		marketing: "Marketing",
		marketingText: "Misurano e personalizzano la pubblicità.",
		media: "Contenuti multimediali",
		mediaText: "Mostrano contenuti di altri siti, come video e mappe.",
		embedText:
			"Questo contenuto proviene da un altro sito, che potrebbe impostare cookie o raccogliere dati sulla tua visita.",
		loadContent: "Carica il contenuto",
		rememberEmbeds: "Carica sempre i contenuti multimediali",
		categories: "Categorie",
	},
	fr: {
		heading: "Vos choix de confidentialité",
		message:
			"Nous aimerions utiliser des cookies et des outils similaires pour les statistiques, le marketing et des contenus d’autres sites, comme les vidéos. Choisissez ce que vous acceptez. Vous pouvez changer d’avis à tout moment avec « Paramètres des cookies ».",
		acceptAll: "Tout accepter",
		rejectAll: "Tout refuser",
		choose: "Choisir",
		save: "Enregistrer mes choix",
		settings: "Paramètres des cookies",
		privacyPolicy: "Politique de confidentialité",
		necessary: "Nécessaires",
		necessaryText: "Font fonctionner le site, par exemple en mémorisant ces choix. Toujours actifs.",
		analytics: "Statistiques",
		analyticsText: "Comptent les visites et montrent comment le site est utilisé.",
		marketing: "Marketing",
		marketingText: "Mesurent et personnalisent la publicité.",
		media: "Médias",
		mediaText: "Affichent des contenus d’autres sites, comme des vidéos et des cartes.",
		embedText:
			"Ce contenu provient d’un autre site, qui peut déposer des cookies ou recueillir des informations sur votre visite.",
		loadContent: "Charger le contenu",
		rememberEmbeds: "Toujours charger les médias",
		categories: "Catégories",
	},
	de: {
		heading: "Ihre Datenschutzeinstellungen",
		message:
			"Wir möchten Cookies und ähnliche Techniken für Statistiken, Marketing und Inhalte anderer Websites wie Videos verwenden. Wählen Sie, was Sie akzeptieren. Sie können Ihre Wahl jederzeit unter „Cookie-Einstellungen“ ändern.",
		acceptAll: "Alle akzeptieren",
		rejectAll: "Alle ablehnen",
		choose: "Auswählen",
		save: "Auswahl speichern",
		settings: "Cookie-Einstellungen",
		privacyPolicy: "Datenschutzerklärung",
		necessary: "Notwendig",
		necessaryText: "Halten die Website in Betrieb, etwa indem sie diese Auswahl speichern. Immer aktiv.",
		analytics: "Statistik",
		analyticsText: "Zählen Besuche und zeigen, wie die Website genutzt wird.",
		marketing: "Marketing",
		marketingText: "Messen und personalisieren Werbung.",
		media: "Medien",
		mediaText: "Zeigen Inhalte anderer Websites, etwa Videos und Karten.",
		embedText:
			"Dieser Inhalt stammt von einer anderen Website, die Cookies setzen oder Daten über Ihren Besuch erfassen kann.",
		loadContent: "Inhalt laden",
		rememberEmbeds: "Medien immer laden",
		categories: "Kategorien",
	},
	es: {
		heading: "Tus opciones de privacidad",
		message:
			"Nos gustaría usar cookies y herramientas similares para estadísticas, marketing y contenido de otros sitios, como vídeos. Elige qué aceptas. Puedes cambiar de opinión en cualquier momento en «Configuración de cookies».",
		acceptAll: "Aceptar todo",
		rejectAll: "Rechazar todo",
		choose: "Elegir",
		save: "Guardar mis opciones",
		settings: "Configuración de cookies",
		privacyPolicy: "Política de privacidad",
		necessary: "Necesarias",
		necessaryText: "Hacen que el sitio funcione, por ejemplo recordando estas opciones. Siempre activas.",
		analytics: "Estadísticas",
		analyticsText: "Cuentan las visitas y muestran cómo se usa el sitio.",
		marketing: "Marketing",
		marketingText: "Miden y personalizan la publicidad.",
		media: "Multimedia",
		mediaText: "Muestran contenido de otros sitios, como vídeos y mapas.",
		embedText: "Este contenido procede de otro sitio, que puede usar cookies o recoger datos sobre tu visita.",
		loadContent: "Cargar el contenido",
		rememberEmbeds: "Cargar siempre el contenido multimedia",
		categories: "Categorías",
	},
	pt: {
		heading: "As suas escolhas de privacidade",
		message:
			"Gostaríamos de usar cookies e ferramentas semelhantes para estatísticas, marketing e conteúdos de outros sites, como vídeos. Escolha o que aceita. Pode mudar de ideia a qualquer momento em «Definições de cookies».",
		acceptAll: "Aceitar tudo",
		rejectAll: "Rejeitar tudo",
		choose: "Escolher",
		save: "Guardar as escolhas",
		settings: "Definições de cookies",
		privacyPolicy: "Política de privacidade",
		necessary: "Necessários",
		necessaryText: "Mantêm o site a funcionar, por exemplo guardando estas escolhas. Sempre ativos.",
		analytics: "Estatísticas",
		analyticsText: "Contam as visitas e mostram como o site é usado.",
		marketing: "Marketing",
		marketingText: "Medem e personalizam a publicidade.",
		media: "Multimédia",
		mediaText: "Mostram conteúdos de outros sites, como vídeos e mapas.",
		embedText: "Este conteúdo vem de outro site, que pode usar cookies ou recolher dados sobre a sua visita.",
		loadContent: "Carregar o conteúdo",
		rememberEmbeds: "Carregar sempre conteúdos multimédia",
		categories: "Categorias",
	},
	nl: {
		heading: "Je privacykeuzes",
		message:
			"We willen cookies en vergelijkbare technieken gebruiken voor statistieken, marketing en inhoud van andere sites, zoals video's. Kies wat je accepteert. Je kunt je keuze altijd wijzigen via ‘Cookie-instellingen’.",
		acceptAll: "Alles accepteren",
		rejectAll: "Alles weigeren",
		choose: "Kiezen",
		save: "Keuzes opslaan",
		settings: "Cookie-instellingen",
		privacyPolicy: "Privacybeleid",
		necessary: "Noodzakelijk",
		necessaryText: "Houden de site werkend, bijvoorbeeld door deze keuzes te onthouden. Altijd aan.",
		analytics: "Statistieken",
		analyticsText: "Tellen bezoeken en laten zien hoe de site wordt gebruikt.",
		marketing: "Marketing",
		marketingText: "Meten en personaliseren advertenties.",
		media: "Media",
		mediaText: "Tonen inhoud van andere sites, zoals video's en kaarten.",
		embedText:
			"Deze inhoud komt van een andere site, die cookies kan plaatsen of gegevens over je bezoek kan verzamelen.",
		loadContent: "Inhoud laden",
		rememberEmbeds: "Media altijd laden",
		categories: "Categorieën",
	},
};

/** WebCraft's own words for the banner in a page's language (by its primary subtag), English when it has none. */
export function consentWords(language: string): ConsentWords {
	const [primary = ""] = language.toLowerCase().split("-");
	return CONSENT_WORDS[primary] ?? (CONSENT_WORDS.en as ConsentWords);
}
