import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { procedure, setCookies, withPerson } from "../context.ts";
import { email, password } from "../inputs.ts";
import { personView } from "../views.ts";

/** Signing in and out of the admin. */
export const session = {
	/** The signed-in person, or null. */
	current: procedure.use(withPerson).handler(({ context }) => ({
		person: context.person ? personView(context.person) : null,
	})),

	/** Checks an email and password and starts a session: the answer sets the session cookie. */
	signIn: procedure.input(z.object({ email, password })).handler(async ({ context, input }) => {
		const { services } = context;
		const { personId, setCookie } = await services.auth.signIn(input, context.headers);
		setCookies(context, setCookie);
		const person = await services.people.get(personId);
		if (!person) throw new ORPCError("INTERNAL_SERVER_ERROR");
		return { person: personView(person) };
	}),

	/** Ends this browser's session: the answer clears the session cookie. */
	signOut: procedure.handler(async ({ context }) => {
		const { setCookie } = await context.services.auth.signOut(context.headers);
		setCookies(context, setCookie);
		return { ok: true as const };
	}),
};
