/**
 * The words of the page a Staging address shows people it doesn't know yet, in the languages pages
 * have their own words in (`pageWords`): English, Italian, French, German, Spanish, Portuguese and
 * Dutch, by the language's primary subtag, English for any other. They never name WebCraft: like
 * everything a Site's hostname answers, the page is unbranded.
 */
export type StagingWords = {
	/** The page's title and heading. */
	title: string;
	/** What the address is, and how to get in. */
	intro: string;
	/** The link to the admin, for people with an account. */
	signIn: string;
	/** What signing in is for. */
	signInHelp: string;
	/** The password form's heading. */
	passwordTitle: string;
	/** What the password is, for people without an account. */
	passwordHelp: string;
	/** The password field's label. */
	password: string;
	/** The button that sends it. */
	submit: string;
	/** Said when the password given isn't the Site's. */
	wrongPassword: string;
	/** Said when one address tried too many passwords. */
	tooMany: string;
	/** Prefixed to the title when the page says something went wrong. */
	errorPrefix: string;
};

const WORDS: Record<string, StagingWords> = {
	en: {
		title: "Sign in to see this site",
		intro: "This is where the site's upcoming changes are reviewed before they go live.",
		signIn: "Sign in",
		signInHelp: "If you have an account, sign in to see the site with its changes.",
		passwordTitle: "Have a password?",
		passwordHelp: "If you were given the site's review password, enter it here.",
		password: "Password",
		submit: "See the site",
		wrongPassword: "That password isn't right. Check it and try again.",
		tooMany: "Too many tries from your network. Wait a minute, then try again.",
		errorPrefix: "Error:",
	},
	it: {
		title: "Accedi per vedere questo sito",
		intro: "Qui si rivedono le prossime modifiche del sito prima che vadano online.",
		signIn: "Accedi",
		signInHelp: "Se hai un account, accedi per vedere il sito con le sue modifiche.",
		passwordTitle: "Hai una password?",
		passwordHelp: "Se ti è stata data la password di revisione del sito, inseriscila qui.",
		password: "Password",
		submit: "Vedi il sito",
		wrongPassword: "La password non è corretta. Controllala e riprova.",
		tooMany: "Troppi tentativi dalla tua rete. Aspetta un minuto e riprova.",
		errorPrefix: "Errore:",
	},
	fr: {
		title: "Connectez-vous pour voir ce site",
		intro: "C'est ici que les prochaines modifications du site sont relues avant leur mise en ligne.",
		signIn: "Se connecter",
		signInHelp: "Si vous avez un compte, connectez-vous pour voir le site avec ses modifications.",
		passwordTitle: "Vous avez un mot de passe ?",
		passwordHelp: "Si l'on vous a donné le mot de passe de relecture du site, saisissez-le ici.",
		password: "Mot de passe",
		submit: "Voir le site",
		wrongPassword: "Ce mot de passe n'est pas le bon. Vérifiez-le et réessayez.",
		tooMany: "Trop d'essais depuis votre réseau. Attendez une minute, puis réessayez.",
		errorPrefix: "Erreur :",
	},
	de: {
		title: "Melden Sie sich an, um diese Website zu sehen",
		intro: "Hier werden die kommenden Änderungen der Website geprüft, bevor sie online gehen.",
		signIn: "Anmelden",
		signInHelp: "Wenn Sie ein Konto haben, melden Sie sich an, um die Website mit ihren Änderungen zu sehen.",
		passwordTitle: "Haben Sie ein Passwort?",
		passwordHelp: "Wenn Sie das Prüfpasswort der Website erhalten haben, geben Sie es hier ein.",
		password: "Passwort",
		submit: "Website ansehen",
		wrongPassword: "Das Passwort stimmt nicht. Prüfen Sie es und versuchen Sie es erneut.",
		tooMany: "Zu viele Versuche aus Ihrem Netzwerk. Warten Sie eine Minute und versuchen Sie es erneut.",
		errorPrefix: "Fehler:",
	},
	es: {
		title: "Inicia sesión para ver este sitio",
		intro: "Aquí se revisan los próximos cambios del sitio antes de publicarlos.",
		signIn: "Iniciar sesión",
		signInHelp: "Si tienes una cuenta, inicia sesión para ver el sitio con sus cambios.",
		passwordTitle: "¿Tienes una contraseña?",
		passwordHelp: "Si te han dado la contraseña de revisión del sitio, escríbela aquí.",
		password: "Contraseña",
		submit: "Ver el sitio",
		wrongPassword: "La contraseña no es correcta. Revísala y vuelve a intentarlo.",
		tooMany: "Demasiados intentos desde tu red. Espera un minuto y vuelve a intentarlo.",
		errorPrefix: "Error:",
	},
	pt: {
		title: "Inicie sessão para ver este site",
		intro: "É aqui que as próximas alterações do site são revistas antes de serem publicadas.",
		signIn: "Iniciar sessão",
		signInHelp: "Se tem uma conta, inicie sessão para ver o site com as suas alterações.",
		passwordTitle: "Tem uma palavra-passe?",
		passwordHelp: "Se recebeu a palavra-passe de revisão do site, introduza-a aqui.",
		password: "Palavra-passe",
		submit: "Ver o site",
		wrongPassword: "A palavra-passe não está correta. Verifique-a e tente de novo.",
		tooMany: "Demasiadas tentativas a partir da sua rede. Aguarde um minuto e tente de novo.",
		errorPrefix: "Erro:",
	},
	nl: {
		title: "Log in om deze site te zien",
		intro: "Hier worden de komende wijzigingen van de site bekeken voordat ze live gaan.",
		signIn: "Inloggen",
		signInHelp: "Heb je een account, log dan in om de site met de wijzigingen te zien.",
		passwordTitle: "Heb je een wachtwoord?",
		passwordHelp: "Als je het reviewwachtwoord van de site hebt gekregen, vul het hier in.",
		password: "Wachtwoord",
		submit: "Bekijk de site",
		wrongPassword: "Dat wachtwoord klopt niet. Controleer het en probeer het opnieuw.",
		tooMany: "Te veel pogingen vanaf je netwerk. Wacht een minuut en probeer het opnieuw.",
		errorPrefix: "Fout:",
	},
};

/** The Staging address's page words in a language, by its primary subtag (`pt-BR` reads `pt`); English for any other. */
export function stagingWords(language: string): StagingWords {
	const primary = language.toLowerCase().split("-")[0] ?? "en";
	return WORDS[primary] ?? (WORDS.en as StagingWords);
}
