/**
 * macOS : signature « ad hoc » de l'application après empaquetage.
 * Sans certificat Apple Developer, l'application n'est pas notarisée, mais une signature ad hoc reste
 * indispensable : les Mac Apple Silicon refusent d'exécuter un binaire arm64 non signé (« application endommagée »).
 * Avec un certificat (variables CSC_LINK / CSC_KEY_PASSWORD), retirez `"identity": null` d'electron-builder.json :
 * electron-builder signera lui-même et cette étape sera ignorée.
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.platform !== "darwin") return; // codesign n'existe que sur macOS
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  console.log(`  • signature ad hoc  ${app}`);
};
