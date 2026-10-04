import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

function encryptionKey() {
  const secret = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be configured with at least 32 characters.");
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptCredential(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export function decryptCredential(payload: string) {
  const [version, ivRaw, tagRaw, encryptedRaw] = payload.split(".");
  if (version !== "v1" || !ivRaw || !tagRaw || !encryptedRaw) {
    throw new Error("Invalid encrypted credential payload.");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivRaw, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
