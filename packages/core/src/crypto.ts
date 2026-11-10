/**
 * Chiffrement AES-256-GCM des secrets (mots de passe SMTP, jetons OAuth).
 * Format : v1.<iv>.<tag>.<données>, en base64url.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function key(hex: string): Buffer {
  const k = Buffer.from(hex, "hex");
  if (k.length !== 32) throw new Error("ENCRYPTION_KEY doit faire 32 octets (64 caractères hexadécimaux)");
  return k;
}

export function encryptSecret(plain: string, hexKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(hexKey), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function decryptSecret(token: string, hexKey: string): string {
  const [v, iv, tag, data] = token.split(".");
  if (v !== "v1" || !iv || !tag || data === undefined) throw new Error("Secret chiffré illisible");
  const decipher = createDecipheriv("aes-256-gcm", key(hexKey), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}
