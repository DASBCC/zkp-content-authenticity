/** Comprueba las hojas, el orden canónico, las rutas y los cambios del conjunto autorizado de fuentes. */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FIELD_MODULUS, stringifyCrypto } from "../src/encoding.mjs";
import { poseidonHash } from "../src/poseidon.mjs";
import { derivePublicKey } from "../src/eddsa.mjs";
import { privateKeyFromHex } from "../src/key-management.mjs";
import { MERKLE_DEPTH } from "../src/protocol.mjs";
import {
  EMPTY_SOURCE_LEAF, MERKLE_CAPACITY, addAuthorizedSource, buildAuthorizedSourcesTree,
  createSourceLeaf, getSourceProof, revokeAuthorizedSource, updateAuthorizedSource, verifySourceProof,
} from "../src/merkle.mjs";
import { temporaryDirectory, vector } from "./fixtures.mjs";

// Clave pública del vector de ensayo de la Fase 1; no contiene un secreto de operación.
const firstSource = { sourceId: 1n, publicKey: vector.publicKey };

/** Ejecuta el administrador de fuentes en otro proceso y devuelve su salida sin alterar el entorno. */
function runSourcesCommand(action, args = []) {
  return spawnSync(process.execPath, [resolve("scripts/sources-cli.mjs"), ...(action ? [action] : []), ...args], {
    encoding: "utf8", timeout: 60000,
  });
}

/** Exige éxito del proceso y devuelve su resultado JSON para las comprobaciones del caso. */
function successfulSourcesCommand(action, args = []) {
  const result = runSourcesCommand(action, args);
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return JSON.parse(result.stdout);
}

/** Comprueba la relación de hoja y que tanto el identificador como la clave quedan comprometidos. */
test("la hoja Merkle vincula sourceId y ambas coordenadas de la clave", async () => {
  const expected = await poseidonHash([1n, BigInt(vector.publicKey[0]), BigInt(vector.publicKey[1])]);
  assert.equal(await createSourceLeaf(firstSource), expected);
  assert.notEqual(await createSourceLeaf({ ...firstSource, sourceId: 2n }), expected);
  const otherKey = await derivePublicKey(privateKeyFromHex("42".repeat(32)));
  assert.notEqual(await createSourceLeaf({ sourceId: 1n, publicKey: otherKey }), expected);
});

/** Reconstruye por separado la raíz vacía y comprueba que ninguna posición represente una fuente autorizada. */
test("el árbol vacío utiliza hojas cero y ocho niveles Poseidon", async () => {
  const tree = await buildAuthorizedSourcesTree([]);
  let expected = EMPTY_SOURCE_LEAF;
  for (let level = 0; level < MERKLE_DEPTH; level++) expected = await poseidonHash([expected, expected]);
  assert.equal(tree.root, expected);
  assert.equal(tree.depth, MERKLE_DEPTH);
  assert.equal(tree.leaves.length, MERKLE_CAPACITY);
  assert.equal(tree.layers.length, MERKLE_DEPTH + 1);
  assert.equal(tree.layers[MERKLE_DEPTH].length, 1);
  for (const leaf of tree.leaves) assert.equal(leaf, 0n);
  await assert.rejects(getSourceProof(tree, 1n), /no está autorizada/);
});

/** Construye el mismo conjunto en órdenes distintos y exige una raíz idéntica sin alterar los datos recibidos. */
test("la raíz es determinista y ordena numéricamente las fuentes", async () => {
  const sources = [{ ...firstSource, sourceId: "10" }, { ...firstSource, sourceId: "2" }, firstSource];
  const original = stringifyCrypto(sources);
  const tree = await buildAuthorizedSourcesTree(sources);
  const reversed = await buildAuthorizedSourcesTree([...sources].reverse());
  assert.equal(tree.root, reversed.root);
  assert.deepEqual([tree.sources[0].sourceId, tree.sources[1].sourceId, tree.sources[2].sourceId], [1n, 2n, 10n]);
  assert.equal(stringifyCrypto(sources), original);
  assert.equal(tree.leaves[3], EMPTY_SOURCE_LEAF);
  assert.equal(Object.isFrozen(tree), true);
  assert.equal(Object.isFrozen(tree.layers[0]), true);
  assert.equal(Object.isFrozen(tree.sources[0].publicKey), true);
});

/** Verifica rutas de posiciones pares e impares y su intercambio mediante cadenas decimales JSON. */
test("las rutas se exportan de abajo hacia arriba y sobreviven a JSON", async () => {
  const tree = await buildAuthorizedSourcesTree([firstSource, { ...firstSource, sourceId: 2n }, { ...firstSource, sourceId: 3n }]);
  for (const sourceId of [1n, 2n, 3n]) {
    const proof = await getSourceProof(tree, sourceId);
    assert.equal(await verifySourceProof(proof), true);
    assert.equal(proof.merklePathElements.length, MERKLE_DEPTH);
    assert.equal(proof.merklePathIndices.length, MERKLE_DEPTH);
    assert.equal(proof.merklePathIndices[0], sourceId === 2n ? 1n : 0n);
    assert.equal(await verifySourceProof(JSON.parse(stringifyCrypto(proof))), true);
  }
  const restoredTree = JSON.parse(stringifyCrypto(tree));
  assert.equal(await verifySourceProof(await getSourceProof(restoredTree, "2")), true);
});

/** Modifica cada componente de una prueba manteniendo su representación válida y exige el rechazo criptográfico. */
test("rechaza hojas, raíces, claves, identificadores y rutas alterados", async () => {
  const tree = await buildAuthorizedSourcesTree([firstSource, { ...firstSource, sourceId: 2n }]);
  const proof = await getSourceProof(tree, 1n);
  assert.equal(await verifySourceProof({ ...proof, sourceId: 3n }), false);
  assert.equal(await verifySourceProof({ ...proof, leaf: (proof.leaf + 1n) % FIELD_MODULUS }), false);
  assert.equal(await verifySourceProof({ ...proof, root: (proof.root + 1n) % FIELD_MODULUS }), false);
  const otherKey = await derivePublicKey(privateKeyFromHex("42".repeat(32)));
  assert.equal(await verifySourceProof({ ...proof, publicKey: otherKey }), false);
  const elements = [...proof.merklePathElements];
  elements[0] = (elements[0] + 1n) % FIELD_MODULUS;
  assert.equal(await verifySourceProof({ ...proof, merklePathElements: elements }), false);
  const indices = [...proof.merklePathIndices];
  indices[0] = 1n;
  assert.equal(await verifySourceProof({ ...proof, merklePathIndices: indices }), false);
});

/** Rechaza niveles incompletos, direcciones no booleanas y representaciones que pierden la forma canónica. */
test("valida la estructura y los valores de las rutas antes de usarlas", async () => {
  const proof = await getSourceProof(await buildAuthorizedSourcesTree([firstSource]), 1n);
  await assert.rejects(verifySourceProof({ ...proof, merklePathElements: proof.merklePathElements.slice(1) }), /niveles/);
  await assert.rejects(verifySourceProof({ ...proof, merklePathIndices: [...proof.merklePathIndices, 0n] }), /niveles/);
  for (const value of [2n, -1n, "01", 0]) {
    const indices = [...proof.merklePathIndices];
    indices[0] = value;
    await assert.rejects(verifySourceProof({ ...proof, merklePathIndices: indices }));
  }
  await assert.rejects(verifySourceProof({ ...proof, root: FIELD_MODULUS }));
  await assert.rejects(verifySourceProof({ ...proof, extra: "no" }), /estructura/);
  await assert.rejects(verifySourceProof({ ...proof, publicKey: [0n, 1n] }));
});

/** Comprueba las reglas del conjunto autorizado antes de construir sus niveles criptográficos. */
test("rechaza fuentes duplicadas, identificadores inválidos y claves ajenas al subgrupo", async () => {
  await assert.rejects(buildAuthorizedSourcesTree([firstSource, { ...firstSource, sourceId: "1" }]), /repetido/);
  for (const sourceId of [0n, -1n, FIELD_MODULUS, 1, "01"]) {
    await assert.rejects(buildAuthorizedSourcesTree([{ ...firstSource, sourceId }]));
  }
  await assert.rejects(buildAuthorizedSourcesTree([{ sourceId: 1n, publicKey: [0n, 1n] }]));
  await assert.rejects(buildAuthorizedSourcesTree([{ ...firstSource, active: true }]), /estructura/);
  await assert.rejects(buildAuthorizedSourcesTree(null), /arreglo/);
});

/** Ocupa todas las hojas y comprueba que el árbol y las altas rechacen fuentes adicionales. */
test("la capacidad fija es 256 fuentes y no se amplía silenciosamente", async () => {
  const sources = [];
  for (let index = 0; index < MERKLE_CAPACITY; index++) {
    sources.push({ ...firstSource, sourceId: BigInt(index) + 1n });
  }
  const tree = await buildAuthorizedSourcesTree(sources);
  assert.equal(tree.sources.length, 256);
  assert.equal(await verifySourceProof(await getSourceProof(tree, 256n)), true);
  const extra = { ...firstSource, sourceId: BigInt(MERKLE_CAPACITY) + 1n };
  await assert.rejects(buildAuthorizedSourcesTree([...sources, extra]), /hasta 256/);
  await assert.rejects(addAuthorizedSource(sources, extra), /hasta 256/);
});

/** Aplica altas y rotaciones de clave sobre nuevos arreglos y comprueba que cambie la raíz autorizada. */
test("las altas y actualizaciones mantienen conjuntos nuevos y ordenados", async () => {
  const sources = [firstSource];
  const added = await addAuthorizedSource(sources, { ...firstSource, sourceId: 2n });
  assert.equal(sources.length, 1);
  assert.equal(added.length, 2);
  assert.deepEqual([added[0].sourceId, added[1].sourceId], [1n, 2n]);
  await assert.rejects(addAuthorizedSource(added, firstSource), /ya está autorizada/);
  const originalTree = await buildAuthorizedSourcesTree(added);
  const otherKey = await derivePublicKey(privateKeyFromHex("42".repeat(32)));
  const rotated = await updateAuthorizedSource(added, { sourceId: 1n, publicKey: otherKey });
  const rotatedTree = await buildAuthorizedSourcesTree(rotated);
  assert.notEqual(originalTree.root, rotatedTree.root);
  const previousProof = await getSourceProof(originalTree, 1n);
  assert.equal(await verifySourceProof({ ...previousProof, root: rotatedTree.root }), false);
  assert.equal(await verifySourceProof(await getSourceProof(rotatedTree, 1n)), true);
  await assert.rejects(updateAuthorizedSource(added, { ...firstSource, sourceId: 9n }), /no está autorizada/);
});

/** Revoca una fuente y exige reconstruir las rutas sin volver a admitirla mediante la raíz nueva. */
test("la revocación elimina la pertenencia y conserva el conjunto anterior", async () => {
  const sources = [firstSource, { ...firstSource, sourceId: 2n }];
  const previous = await buildAuthorizedSourcesTree(sources);
  const revokedProof = await getSourceProof(previous, 1n);
  const active = await revokeAuthorizedSource(sources, 1n);
  const next = await buildAuthorizedSourcesTree(active);
  assert.equal(sources.length, 2);
  assert.equal(active.length, 1);
  assert.equal(active[0].sourceId, 2n);
  assert.notEqual(previous.root, next.root);
  assert.equal(await verifySourceProof({ ...revokedProof, root: next.root }), false);
  await assert.rejects(getSourceProof(next, 1n), /no está autorizada/);
  assert.equal(await verifySourceProof(await getSourceProof(next, 2n)), true);
  await assert.rejects(revokeAuthorizedSource(active, 1n), /no está autorizada/);
  const empty = await buildAuthorizedSourcesTree(await revokeAuthorizedSource(active, 2n));
  assert.equal(empty.sources.length, 0);
});

/** Comprueba el manejo real de archivos de fuentes y rutas sin publicar identidades en la consola. */
test("el CLI administra fuentes, genera rutas y distingue una prueba alterada", { timeout: 120000 }, async () => {
  const directory = await temporaryDirectory("sources-cli-");
  try {
    const emptyFile = join(directory, "empty.json");
    const publicFile = join(directory, "public.json");
    const replacementFile = join(directory, "replacement-public.json");
    const firstFile = join(directory, "first.json");
    const secondFile = join(directory, "second.json");
    const rotatedFile = join(directory, "rotated.json");
    const revokedFile = join(directory, "revoked.json");
    const rootFile = join(directory, "root.json");
    const proofFile = join(directory, "proof.json");
    const invalidFile = join(directory, "invalid-proof.json");
    await writeFile(emptyFile, "[]\n");
    await writeFile(publicFile, JSON.stringify(vector.publicKey));
    const otherKey = await derivePublicKey(privateKeyFromHex("42".repeat(32)));
    await writeFile(replacementFile, stringifyCrypto(otherKey));
    const empty = successfulSourcesCommand("build", ["--sources", emptyFile, "--out", rootFile]);
    assert.deepEqual(Object.keys(empty), ["root", "depth", "count"]);
    assert.equal(empty.count, 0);
    assert.deepEqual(JSON.parse(await readFile(rootFile, "utf8")), empty);
    const first = successfulSourcesCommand("add", ["--sources", emptyFile, "--source-id", "20", "--public-key", publicFile, "--out", firstFile]);
    assert.equal(first.count, 1);
    assert.deepEqual(JSON.parse(await readFile(emptyFile, "utf8")), []);
    const second = successfulSourcesCommand("add", ["--sources", firstFile, "--source-id", "5", "--public-key", publicFile, "--out", secondFile]);
    assert.equal(second.count, 2);
    const secondSources = JSON.parse(await readFile(secondFile, "utf8"));
    assert.deepEqual([secondSources[0].sourceId, secondSources[1].sourceId], ["5", "20"]);
    const rotated = successfulSourcesCommand("update", ["--sources", secondFile, "--source-id", "20", "--public-key", replacementFile, "--out", rotatedFile]);
    assert.notEqual(rotated.root, second.root);
    const output = successfulSourcesCommand("proof", ["--sources", rotatedFile, "--source-id", "20", "--out", proofFile]);
    assert.deepEqual(Object.keys(output), ["proofFile", "root"]);
    assert.equal(output.root, rotated.root);
    assert.doesNotMatch(JSON.stringify(output), /sourceId|publicKey|merklePathElements/);
    const proof = JSON.parse(await readFile(proofFile, "utf8"));
    assert.equal(await verifySourceProof(proof), true);
    assert.deepEqual(successfulSourcesCommand("verify", ["--input", proofFile]), { valid: true });
    const invalid = { ...proof, root: ((BigInt(proof.root) + 1n) % FIELD_MODULUS).toString() };
    await writeFile(invalidFile, stringifyCrypto(invalid));
    const rejected = runSourcesCommand("verify", ["--input", invalidFile]);
    assert.equal(rejected.status, 2, rejected.stderr);
    assert.deepEqual(JSON.parse(rejected.stdout), { valid: false });
    const revoked = successfulSourcesCommand("revoke", ["--sources", rotatedFile, "--source-id", "20", "--out", revokedFile]);
    assert.equal(revoked.count, 1);
    assert.equal(JSON.parse(await readFile(rotatedFile, "utf8")).length, 2);
    assert.equal(runSourcesCommand("proof", ["--sources", revokedFile, "--source-id", "20", "--out", join(directory, "revoked-proof.json")]).status, 1);
    assert.equal(runSourcesCommand("add", ["--sources", emptyFile, "--source-id", "30", "--public-key", publicFile, "--out", firstFile]).status, 1);
    assert.equal(JSON.parse(await readFile(firstFile, "utf8"))[0].sourceId, "20");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** Rechaza comandos incompletos y JSON mal formado sin mostrar su contenido en los errores. */
test("el CLI de fuentes valida argumentos y ofrece ayuda en español", async () => {
  const directory = await temporaryDirectory("sources-help-");
  try {
    for (const action of ["build", "add", "update", "revoke", "proof", "verify"]) {
      const help = runSourcesCommand(action, ["--help"]);
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /Uso:/);
      assert.equal(runSourcesCommand(action, ["--unknown"]).status, 1);
    }
    assert.equal(runSourcesCommand(undefined, ["--help"]).status, 0);
    assert.equal(runSourcesCommand().status, 1);
    assert.equal(runSourcesCommand("unknown").status, 1);
    assert.equal(runSourcesCommand("build").status, 1);
    assert.equal(runSourcesCommand("proof", ["--sources", join(directory, "missing.json"), "--source-id", "1"]).status, 1);
    const invalidFile = join(directory, "invalid.json");
    const marker = "contenido-privado-no-debe-aparecer";
    await writeFile(invalidFile, "{" + marker);
    const failed = runSourcesCommand("build", ["--sources", invalidFile]);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /JSON no es válido/);
    assert.ok(!failed.stderr.includes(marker));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
