import fs from "node:fs/promises";
import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";

function authorizationHashToBytes(authorizationHash) {
  const value = BigInt(authorizationHash);

  let hex = value.toString(16);

  if (hex.length % 2 !== 0) {
    hex = "0" + hex;
  }

  hex = hex.padStart(64, "0");

  return Buffer.from(hex, "hex");
}

export async function signAuthorizationHash(
  authorizationHash,
  privateKeyPath
) {
  const privateKeyPem = await fs.readFile(privateKeyPath, "utf8");

  const privateKey = createPrivateKey(privateKeyPem);

  const message = authorizationHashToBytes(authorizationHash);

  const signature = sign(null, message, privateKey);

  return signature.toString("hex");
}

export async function verifyAuthorizationSignature(
  authorizationHash,
  signatureHex,
  publicKeyPath
) {
  const publicKeyPem = await fs.readFile(publicKeyPath, "utf8");

  const publicKey = createPublicKey(publicKeyPem);

  const message = authorizationHashToBytes(authorizationHash);
  const signature = Buffer.from(signatureHex, "hex");

  return verify(null, message, publicKey, signature);
}