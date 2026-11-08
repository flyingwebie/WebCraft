import { defineRelations } from "drizzle-orm";

import * as schema from "./schema/index.ts";

export const relations = defineRelations(schema);
