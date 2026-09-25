import test from "node:test";
import assert from "node:assert/strict";

import { calculateContentHash } from "../src/hash/poseidon.mjs";
import { calculateAuthorizationHash } from "../src/authorization/authorization.mjs";

const registrant = "0x1111111111111111111111111111111111111111";

test("los mismos datos producen el mismo authorizationHash", async () => {
  const contentHash = await calculateContentHash("samples/prueba.txt");

  const auth1 = await calculateAuthorizationHash({
    contentHash,
    protocolVersion: 1,
    sourceId: 1,
    nonce: 1,
    registrant,
  });

  const auth2 = await calculateAuthorizationHash({
    contentHash,
    protocolVersion: 1,
    sourceId: 1,
    nonce: 1,
    registrant,
  });

  assert.equal(auth1, auth2);
});

test("cambiar el nonce produce un authorizationHash diferente", async () => {
  const contentHash = await calculateContentHash("samples/prueba.txt");

  const auth1 = await calculateAuthorizationHash({
    contentHash,
    protocolVersion: 1,
    sourceId: 1,
    nonce: 1,
    registrant,
  });

  const auth2 = await calculateAuthorizationHash({
    contentHash,
    protocolVersion: 1,
    sourceId: 1,
    nonce: 2,
    registrant,
  });

  assert.notEqual(auth1, auth2);
});

test("cambiar el registrant produce un authorizationHash diferente", async () => {
  const contentHash = await calculateContentHash("samples/prueba.txt");

  const auth1 = await calculateAuthorizationHash({
    contentHash,
    protocolVersion: 1,
    sourceId: 1,
    nonce: 1,
    registrant: "0x1111111111111111111111111111111111111111",
  });

  const auth2 = await calculateAuthorizationHash({
    contentHash,
    protocolVersion: 1,
    sourceId: 1,
    nonce: 1,
    registrant: "0x2222222222222222222222222222222222222222",
  });

  assert.notEqual(auth1, auth2);
});