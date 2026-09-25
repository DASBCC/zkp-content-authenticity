import { calculateContentHash } from "../src/hash/poseidon.mjs";

import {
  calculateAuthorizationHash,
} from "../src/authorization/authorization.mjs";

import {
  signAuthorizationHash,
  verifyAuthorizationSignature,
} from "../src/signature/ed25519.mjs";

const filePath = "samples/prueba.txt";

console.log("1. Procesando archivo...");

const contentHash = await calculateContentHash(filePath);

console.log("contentHash:");
console.log(contentHash);

console.log("\n2. Construyendo autorización...");

const authorizationHash = await calculateAuthorizationHash({
  contentHash,
  protocolVersion: 1,
  sourceId: 1,
  nonce: 1,
  registrant: "0x1111111111111111111111111111111111111111",
});

console.log("authorizationHash:");
console.log(authorizationHash);

console.log("\n3. Firmando autorización...");

const signature = await signAuthorizationHash(
  authorizationHash,
  "keys/source-private.pem"
);

console.log("Firma generada:");
console.log(signature);

console.log("\n4. Verificando firma...");

const valid = await verifyAuthorizationSignature(
  authorizationHash,
  signature,
  "keys/source-public.pem"
);

console.log("Firma válida:");
console.log(valid);