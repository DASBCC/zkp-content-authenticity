import fs from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
  publicKeyEncoding: {
    type: "spki",
    format: "pem",
  },
  privateKeyEncoding: {
    type: "pkcs8",
    format: "pem",
  },
});

await fs.mkdir("keys", { recursive: true });

await fs.writeFile("keys/source-private.pem", privateKey);
await fs.writeFile("keys/source-public.pem", publicKey);

console.log("Par de claves Ed25519 generado correctamente.");
console.log("Clave privada: keys/source-private.pem");
console.log("Clave pública: keys/source-public.pem");