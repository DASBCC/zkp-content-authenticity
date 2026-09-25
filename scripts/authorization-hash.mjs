import { calculateContentHash } from "../src/hash/poseidon.mjs";
import { calculateAuthorizationHash } from "../src/authorization/authorization.mjs";

const contentHash = await calculateContentHash("samples/prueba.txt");

const authorizationHash = await calculateAuthorizationHash({
  contentHash,
  protocolVersion: 1,
  sourceId: 1,
  nonce: 1,
  registrant: "0x1111111111111111111111111111111111111111",
});

console.log("contentHash:");
console.log(contentHash);

console.log("\nauthorizationHash:");
console.log(authorizationHash);