/**
 * Prépare le dossier `stage/` empaqueté par electron-builder :
 *   stage/app/            main.cjs (processus principal, tout le serveur compilé en un fichier) + node_modules/@electric-sql/pglite
 *   stage/resources/      migrations SQL, interface Next.js autonome, icônes
 */
import { build } from "esbuild";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  author: { name: "Automatisation Mail", email: "ck526438-lgtm@users.noreply.github.com" },
  homepage: "https://github.com/ck526438-lgtm/automatisation-mail", main: "main.cjs", license: "UNLICENSED",
  dependencies: { "@electric-sql/pglite": pgliteVersion },
}, null, 2));

step("Migrations SQL");
cpSync(path.join(root, "packages/db/migrations"), path.join(res, "migrations"), { recursive: true });

step("Interface (serveur Next.js autonome)");
const web = path.join(root, "apps/web");
const standalone = path.join(web, ".next/standalone");
if (!existsSync(standalone)) throw new Error("apps/web/.next/standalone absent : lancez sans --skip-web");
// dereference : Windows et les installateurs gèrent mal les liens symboliques de pnpm.
cpSync(standalone, path.join(res, "web"), { recursive: true, dereference: true });
cpSync(path.join(web, ".next/static"), path.join(res, "web/apps/web/.next/static"), { recursive: true });
cpSync(path.join(web, "public"), path.join(res, "web/apps/web/public"), { recursive: true });
// Paquets inutiles à l'exécution, tirés par le traçage de Next.
const webModules = path.join(res, "web/node_modules");
rmSync(path.join(webModules, "typescript"), { recursive: true, force: true });
for (const d of existsSync(path.join(webModules, ".pnpm")) ? readdirSync(path.join(webModules, ".pnpm")) : []) {
  if (d.startsWith("typescript@")) rmSync(path.join(webModules, ".pnpm", d), { recursive: true, force: true });
}

// Next trace ses dépendances dans l'arborescence de pnpm (node_modules/.pnpm + liens symboliques). Une fois copiés,
// ces liens pointent encore vers le dossier de construction : l'application installée ne retrouverait pas ses modules,
// et macOS refuse de signer un paquet qui en contient. On reconstruit donc un node_modules « à plat », sans aucun lien.
function symlinksIn(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) found.push(p);
    else if (st.isDirectory()) found.push(...symlinksIn(p));
  }
  return found;
}
const store = path.join(standalone, "node_modules/.pnpm");
if (existsSync(store)) {
  rmSync(webModules, { recursive: true, force: true });
  rmSync(path.join(res, "web/apps/web/node_modules"), { recursive: true, force: true });
  const versions = new Map();
  let count = 0;
  for (const entry of readdirSync(store)) {
    const modules = path.join(store, entry, "node_modules");
    if (entry === "node_modules" || entry.startsWith("typescript@") || !existsSync(modules)) continue;
    const names = readdirSync(modules).flatMap((n) => (n.startsWith("@") ? readdirSync(path.join(modules, n)).map((m) => `${n}/${m}`) : [n]));
    for (const name of names) {
      const src = path.join(modules, name);
      if (lstatSync(src).isSymbolicLink()) continue; // dépendance d'un autre paquet : copiée depuis sa propre entrée
      const manifest = path.join(src, "package.json");
      const version = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")).version : entry;
      if (versions.has(name)) {
        if (versions.get(name) !== version) throw new Error(`Deux versions de ${name} dans l'interface (${versions.get(name)} et ${version}) : arborescence à plat impossible`);
        continue;
      }
      versions.set(name, version);
      cpSync(src, path.join(webModules, name), { recursive: true });
      count++;
    }
  }
  step(`Modules de l'interface mis à plat (${count} paquets)`);
}
const leftovers = symlinksIn(stage);
if (leftovers.length) throw new Error(`Liens symboliques restants dans stage/ (${leftovers.length}) : ${leftovers[0]}`);

step("Icônes");
cpSync(path.join(desktop, "assets"), path.join(res, "assets"), { recursive: true });

console.log("✔ Prêt dans apps/desktop/stage");
