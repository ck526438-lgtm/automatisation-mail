import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { createHash, randomBytes } from "node:crypto";
import * as schema from "./schema.js";

export * from "./schema.js";
export * from "./services.js";
export { schema };
export { and, or, eq, sql, desc, asc, inArray, isNull, lte, gte, count } from "drizzle-orm";
import { sql, type SQL } from "drizzle-orm";

/**
 * Convertit une requête texte à placeholders $1, $2… (ex. sortie de segmentToSql)
 * en fragment Drizzle paramétré, sans concaténer de valeurs dans le SQL.
 */
export function paramSql(text: string, params: unknown[]): SQL {
  const parts = text.split(/\$(\d+)/);
  const chunks: SQL[] = parts.map((part, i) => (i % 2 === 0 ? sql.raw(part) : sql`${params[Number(part) - 1]}`));
  return sql.join(chunks, sql.raw(""));
}

export type Db = NodePgDatabase<typeof schema>;

export function createDb(url = process.env.DATABASE_URL ?? "postgres://am:am@localhost:5432/automatisation_mail"): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 10) });
  return { db: drizzle(pool, { schema }), pool };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(): string {
  return `am_${randomBytes(24).toString("base64url")}`;
}
