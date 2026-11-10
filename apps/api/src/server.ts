import { createDb } from "@am/db";
import { buildApp } from "./app.js";
import { config } from "./config.js";

const { db, pool } = createDb();
const app = await buildApp({ db });

const close = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);

await app.listen({ port: config.port, host: "0.0.0.0" });
