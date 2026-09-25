import { calculateContentHash } from "../src/hash/poseidon.mjs";

import {
  calculateAuthorizationHash,
} from "../src/authorization/authorization.mjs";

import {
  signAuthorizationHash,
  verifyAuthorizationSignature,
} from "../src/signature/ed25519.mjs";

const contentHash = await calculateContentHash(
  "samples/prueba.txt"
);

const authorizationHash = await calculateAuthorizationHash({
  contentHash,
  protocolVersion: 1,
  sourceId: 1,
  nonce: 1,
  registrant: "0x1111111111111111111111111111111111111111",
});

const signature = await signAuthorizationHash(
  authorizationHash,
  "keys/source-private.pem"
);

const valid = await verifyAuthorizationSignature(
  authorizationHash,
  signature,
  "keys/source-public.pem"
);

console.log("contentHash:");
console.log(contentHash);

console.log("\nauthorizationHash:");
console.log(authorizationHash);

console.log("\nFirma Ed25519:");
console.log(signature);

console.log("\nFirma válida:");
console.log(valid);