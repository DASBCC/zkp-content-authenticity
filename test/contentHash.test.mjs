import test from "node:test";
import assert from "node:assert/strict";

import { calculateContentHash } from "../src/hash/poseidon.mjs";

test("el mismo archivo produce el mismo contentHash", async () => {
  const hash1 = await calculateContentHash("samples/prueba.txt");
  const hash2 = await calculateContentHash("samples/prueba.txt");

  assert.equal(hash1, hash2);
});

test("un archivo modificado produce un contentHash diferente", async () => {
  const hashOriginal = await calculateContentHash("samples/prueba.txt");

  const hashModificado = await calculateContentHash(
    "samples/prueba-modificada.txt"
  );

  assert.notEqual(hashOriginal, hashModificado);
});