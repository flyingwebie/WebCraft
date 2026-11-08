import { createAuth } from "@webcraft/auth";
import { createDb } from "@webcraft/db";

import { ENV } from "./env.server";

export const db = createDb(ENV);
export const auth = createAuth(ENV, db);
