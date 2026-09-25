import test from "node:test";
import assert from "node:assert/strict";

import { calculateContentHash } from "../src/hash/poseidon.mjs";
import { calculateAuthorizationHash } from "../src/authorization/authorization.mjs";

import {
  signAuthorizationHash,
  verifyAuthorizationSignature,
} from "../src/signature/ed25519.mjs";

const privateKeyPath = "keys/source-private.pem";
const publicKeyPath = "keys/source-public.pem";

async function getAuthorizationHash() {
  const contentHash = await calculateContentHash("samples/prueba.txt");

  return calculateAuthorizationHash({
    contentHash,
    protocolVersion: 1,
    sourceId: 1,
    nonce: 1,
    registrant: "0x1111111111111111111111111111111111111111",
  });
}

test("una firma válida puede ser verificada", async () => {
  const authorizationHash = await getAuthorizationHash();

  const signature = await signAuthorizationHash(
    authorizationHash,
    privateKeyPath
  );

  const valid = await verifyAuthorizationSignature(
    authorizationHash,
    signature,
    publicKeyPath
  );

  assert.equal(valid, true);
});

test("la firma deja de ser válida si cambia authorizationHash", async () => {
  const authorizationHash = await getAuthorizationHash();

  const signature = await signAuthorizationHash(
    authorizationHash,
    privateKeyPath
  );

  const modifiedAuthorizationHash =
    (BigInt(authorizationHash) + 1n).toString();

  const valid = await verifyAuthorizationSignature(
    modifiedAuthorizationHash,
    signature,
    publicKeyPath
  );

  assert.equal(valid, false);
});

test("una firma modificada es rechazada", async () => {
  const authorizationHash = await getAuthorizationHash();

  const signature = await signAuthorizationHash(
    authorizationHash,
    privateKeyPath
  );

  const signatureBuffer = Buffer.from(signature, "hex");

  // Modificamos un byte de la firma.
  signatureBuffer[0] ^= 0x01;

  const modifiedSignature = signatureBuffer.toString("hex");

  const valid = await verifyAuthorizationSignature(
    authorizationHash,
    modifiedSignature,
    publicKeyPath
  );

  assert.equal(valid, false);
});