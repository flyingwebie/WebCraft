import type { Session } from "@webcraft/auth";
import type { Database } from "@webcraft/db";

export type Context = {
  session: Session | null;
  db: Database;
};
