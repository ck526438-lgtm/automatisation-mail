import path from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Serveur autonome : utilisé par l'image Docker et embarqué dans l'application Windows.
  output: "standalone",
  outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
