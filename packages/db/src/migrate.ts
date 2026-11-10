/**
 * Applique les migrations SQL (mode serveur) : pnpm db:migrate
 */
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./index.js";

const { db, pool } = createDb();
await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
console.log("✔ Migrations appliquées");
await pool.end();
