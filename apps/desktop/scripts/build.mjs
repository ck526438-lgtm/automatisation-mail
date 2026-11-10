/**
 * Prépare le dossier `stage/` empaqueté par electron-builder :
 *   stage/app/            main.cjs (processus principal, tout le serveur compilé en un fichier) + node_modules/@electric-sql/pglite
 *   stage/resources/      migrations SQL, interface Next.js autonome, icônes
 */
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, "..");
const root = path.resolve(desktop, "../..");
const stage = path.join(desktop, "stage");
const appDir = path.join(stage, "app");
const res = path.join(stage, "resources");
const step = (m) => console.log(`• ${m}`);

rmSync(stage, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });
mkdirSync(res, { recursive: true });

if (!process.argv.includes("--skip-web")) {
  step("Construction des paquets et de l'interface");
  execSync("pnpm --filter @am/core --filter @am/db build", { cwd: root, stdio: "inherit" });
  execSync("pnpm --filter @am/web build", { cwd: root, stdio: "inherit" });
}

step("Compilation du processus principal");
const common = {
  bundle: true, platform: "node", target: "node20", format: "cjs", sourcemap: "linked", logLevel: "warning",
  // PGlite charge ses fichiers .wasm/.data à côté de son module : il reste un vrai paquet.
  external: ["electron", "@electric-sql/pglite"],
  // Les paquets du dépôt sont pris depuis leurs sources TypeScript.
  alias: { "@am/core": path.join(root, "packages/core/src/index.ts"), "@am/db": path.join(root, "packages/db/src/index.ts"), "@am/db/local": path.join(root, "packages/db/src/local.ts") },
  // Dépendances facultatives de bibliothèques, jamais utilisées ici.
  plugins: [{ name: "optional", setup(b) { b.onResolve({ filter: /^(pino-pretty|@fastify\/swagger|bufferutil|utf-8-validate|kerberos|snappy|@mongodb-js\/zstd|aws4|mongodb-client-encryption|pg-native)$/ }, () => ({ path: "x", namespace: "optional" })); b.onLoad({ filter: /.*/, namespace: "optional" }, () => ({ contents: "module.exports = {}" })); } }],
};
await build({ ...common, entryPoints: [path.join(desktop, "src/main.ts")], outfile: path.join(appDir, "main.cjs") });
await build({ ...common, entryPoints: [path.join(desktop, "src/smoke.ts")], outfile: path.join(stage, "smoke.cjs") });

step("PGlite (base embarquée)");
// Le paquet n'exporte pas package.json : on remonte depuis son point d'entrée (dist/index.cjs).
const require = createRequire(path.join(root, "packages/db/package.json"));
const pgliteDir = path.resolve(path.dirname(realpathSync(require.resolve("@electric-sql/pglite"))), "..");
cpSync(pgliteDir, path.join(appDir, "node_modules/@electric-sql/pglite"), { recursive: true, dereference: true });

const pkg = JSON.parse(readFileSync(path.join(desktop, "package.json"), "utf8"));
const pgliteVersion = JSON.parse(readFileSync(path.join(pgliteDir, "package.json"), "utf8")).version;
// Seule dépendance à l'exécution (tout le reste est compilé dans main.cjs). Déclarée pour qu'electron-builder l'embarque.
writeFileSync(path.join(appDir, "package.json"), JSON.stringify({
  name: "automatisation-mail", productName: pkg.productName, version: pkg.version, description: pkg.description,
  author: "Automatisation Mail", main: "main.cjs", license: "UNLICENSED",
  dependencies: { "@electric-sql/pglite": pgliteVersion },
}, null, 2));

step("Migrations SQL");
cpSync(path.join(root, "packages/db/migrations"), path.join(res, "migrations"), { recursive: true });

step("Interface (serveur Next.js autonome)");
const web = path.join(root, "apps/web");
const standalone = path.join(web, ".next/standalone");
if (!existsSync(standalone)) throw new Error("apps/web/.next/standalone absent : lancez sans --skip-web");
// dereference : Windows et l'installateur gèrent mal les liens symboliques de pnpm.
cpSync(standalone, path.join(res, "web"), { recursive: true, dereference: true });
cpSync(path.join(web, ".next/static"), path.join(res, "web/apps/web/.next/static"), { recursive: true });
cpSync(path.join(web, "public"), path.join(res, "web/apps/web/public"), { recursive: true });
// Paquets inutiles à l'exécution, tirés par le traçage de Next.
const webModules = path.join(res, "web/node_modules");
rmSync(path.join(webModules, "typescript"), { recursive: true, force: true });
for (const d of existsSync(path.join(webModules, ".pnpm")) ? readdirSync(path.join(webModules, ".pnpm")) : []) {
  if (d.startsWith("typescript@")) rmSync(path.join(webModules, ".pnpm", d), { recursive: true, force: true });
}

step("Icônes");
cpSync(path.join(desktop, "assets"), path.join(res, "assets"), { recursive: true });

console.log("✔ Prêt dans apps/desktop/stage");
