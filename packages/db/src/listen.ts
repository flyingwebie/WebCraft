import pg from "pg";

/** A connection listening on one Postgres notification channel. */
export type Listener = {
	/** Stops listening and closes the connection. */
	close(): Promise<void>;
};

export type ListenOptions = {
	/** Shown in `pg_stat_activity`, such as `webcraft-web`. */
	applicationName?: string;
	/** Each notification's payload, as sent. */
	onNotice(payload: string): void;
	/**
	 * After the connection dropped and listening started again: notifications sent in between were
	 * missed, so whoever listens reads what changed again.
	 */
	onReconnect?(): void;
	/** Something went wrong with the connection; it is tried again a second later. */
	onError?(error: unknown): void;
};

/**
 * Listens on a channel (LISTEN/NOTIFY) on a connection of its own, outside the pool, kept open until
 * `close()`: a notification is delivered to every listening connection once the transaction that sent
 * it commits. A dropped connection is opened again a second later.
 */
export async function listen(databaseUrl: string, channel: string, options: ListenOptions): Promise<Listener> {
	let closed = false;
	let client: pg.Client | null = null;
	let retry: ReturnType<typeof setTimeout> | undefined;

	const connect = async (again: boolean): Promise<void> => {
		const next = new pg.Client({
			connectionString: databaseUrl,
			application_name: options.applicationName ?? "webcraft",
		});
		next.on("notification", (message) => {
			if (message.channel === channel && message.payload !== undefined) options.onNotice(message.payload);
		});
		const lost = (error?: unknown) => {
			if (client !== next) return;
			client = null;
			if (error) options.onError?.(error);
			next.end().catch(() => {});
			if (!closed) retry = setTimeout(() => void connect(true).catch(() => {}), 1000);
		};
		next.on("error", lost);
		next.on("end", () => lost());
		try {
			await next.connect();
			await next.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
		} catch (error) {
			options.onError?.(error);
			await next.end().catch(() => {});
			if (!again) throw error;
			if (!closed) retry = setTimeout(() => void connect(true).catch(() => {}), 1000);
			return;
		}
		if (closed) {
			await next.end().catch(() => {});
			return;
		}
		client = next;
		if (again) options.onReconnect?.();
	};

	await connect(false);
	return {
		async close() {
			closed = true;
			clearTimeout(retry);
			const open = client;
			client = null;
			await open?.end().catch(() => {});
		},
	};
}
