/**
 * Base embarquée pour l'application Windows : PostgreSQL compilé en WebAssembly (PGlite),
 * stocké dans un dossier du poste. Même schéma, mêmes requêtes que le mode serveur.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "./index.js";
import * as schema from "./schema.js";

export interface LocalDb {
  db: Db;
  client: PGlite;
  close(): Promise<void>;
}

/** Ouvre (ou crée) la base dans `dataDir` et applique les migrations en attente. */
export async function openLocalDb(dataDir: string, migrationsFolder: string): Promise<LocalDb> {
  const client = new PGlite(dataDir);
  await client.waitReady;
  const db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client, { schema }), { migrationsFolder });
  return { db, client, close: () => client.close() };
}
