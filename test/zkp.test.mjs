/** Comprueba las restricciones del circuito completo, la privacidad de sus señales y las pruebas Groth16 reales. */

import test, { before } from "node:test";
import assert from "node:assert/strict";
import { cp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { wtns } from "snarkjs";
import { signContentAuthorization } from "../src/authorization.mjs";
import { derivePublicKey } from "../src/eddsa.mjs";
import { FIELD_MODULUS, stringifyCrypto } from "../src/encoding.mjs";
import { privateKeyFromHex } from "../src/key-management.mjs";
import { buildAuthorizedSourcesTree, getSourceProof } from "../src/merkle.mjs";
import { calculateNullifier, generateNonce, NONCE_LIMIT, PROTOCOL_DOMAIN, PUBLIC_SIGNAL_NAMES, publicSignalsFromInput } from "../src/protocol.mjs";
import { poseidonHash } from "../src/poseidon.mjs";
import { artifactPaths, calculateWitness, createProofInputs, ensureZkArtifacts, generateProof, verifyProof } from "../src/zkp.mjs";
import { temporaryDirectory, testSeed, vector } from "./fixtures.mjs";

let fixture;

/** Prepara una autorización de ensayo y su pertenencia a una raíz conocida, sin regenerar la ceremonia. */
before(async () => {
  const manifest = await ensureZkArtifacts();
  const publicKey = await derivePublicKey(testSeed());
  const otherKey = await derivePublicKey(privateKeyFromHex("42".repeat(32)));
  const tree = await buildAuthorizedSourcesTree([{ sourceId: 1n, publicKey }, { sourceId: 2n, publicKey: otherKey }]);
  const operation = { ...vector.operation, nonce: generateNonce() };
  const authorization = await signContentAuthorization({ contentHash: vector.contentHashes[62], ...operation }, testSeed());
  const membership = await getSourceProof(tree, 1n);
  const inputs = await createProofInputs(authorization, membership);
  fixture = { manifest, publicKey, otherKey, tree, authorization, membership, inputs };
});

/** Comprueba la fórmula y los rangos del identificador consumible sin convertir datos de campo a Number. */
test("el nullifier reproduce la fórmula Poseidon y el nonce tiene 248 bits aleatorios", async () => {
  const first = generateNonce();
  const second = generateNonce();
  assert.ok(first > 0n && first < NONCE_LIMIT);
  assert.notEqual(first, second);
  const value = { sourceId: 1n, nonce: first, protocolVersion: 1n, chainId: 31337n, registryAddress: vector.operation.context.registryAddress };
  assert.equal(await calculateNullifier(value), await poseidonHash([1n, first, 1n, 31337n, BigInt(value.registryAddress)]));
  for (const name of ["sourceId", "nonce", "protocolVersion", "chainId", "registryAddress"]) {
    const changed = name === "registryAddress" ? "0x3333333333333333333333333333333333333333" : value[name] + 1n;
    assert.notEqual(await calculateNullifier(value), await calculateNullifier({ ...value, [name]: changed }));
  }
  await assert.rejects(calculateNullifier({ ...value, nonce: 0n }));
  await assert.rejects(calculateNullifier({ ...value, nonce: NONCE_LIMIT }));
});

/** Comprueba que sólo se publiquen los ocho campos previstos y que el circuito no tenga salidas adicionales. */
test("el circuito expone ocho señales públicas y ninguna identidad privada ni salida", async () => {
  const key = JSON.parse(await readFile(artifactPaths().verificationKey, "utf8"));
  assert.equal(key.nPublic, 8);
  assert.equal(key.IC.length, 9);
  assert.equal(fixture.manifest.metrics.publicInputs, 8);
  assert.equal(fixture.manifest.metrics.outputs, 0);
  assert.deepEqual(fixture.manifest.parameters.publicSignals, [...PUBLIC_SIGNAL_NAMES]);
  for (const privateName of ["sourceId", "nonce", "publicKeyX", "publicKeyY", "R8x", "R8y", "S", "merklePathElements", "merklePathIndices"]) {
    assert.ok(!PUBLIC_SIGNAL_NAMES.includes(privateName));
  }
  assert.equal(fixture.inputs.protocolDomain, PROTOCOL_DOMAIN.toString());
});

/** Genera un testigo válido con el adaptador y elimina el archivo privado al terminar la comprobación. */
test("la firma autorizada y la ruta válida producen un testigo real", async () => {
  const result = await calculateWitness(fixture.inputs);
  try { assert.ok((await readFile(result.witnessPath)).byteLength > 0); }
  finally { await unlink(result.witnessPath); }
  assert.ok(result.metrics.witnessMs >= 0);
});

// Cada alteración se introduce después del adaptador para demostrar el rechazo dentro del propio WASM.
const mutations = [
  ["firma alterada", "S", 1n], ["huella manipulada", "contentHash", 1n],
  ["versión diferente", "protocolVersion", 1n], ["registrante diferente", "registrant", 1n],
  ["otra cadena", "chainId", 1n], ["otro registro", "registryAddress", 1n],
  ["dominio diferente", "protocolDomain", 1n], ["nullifier arbitrario", "nullifier", 1n],
  ["raíz incorrecta", "authorizedSourcesRoot", 1n], ["nonce distinto", "nonce", 1n],
];

for (const [label, name, amount] of mutations) {
  /** Modifica un dato del testigo sin cambiar la firma y exige que una restricción del circuito lo rechace. */
  test("el circuito rechaza " + label, async (t) => {
    t.mock.method(console, "error", /* Oculta únicamente los mensajes de los rechazos esperados. */ () => {});
    const inputs = { ...fixture.inputs, [name]: ((BigInt(fixture.inputs[name]) + amount) % FIELD_MODULUS).toString() };
    await assert.rejects(wtns.calculate(inputs, artifactPaths().wasm, { type: "mem" }, { sanityCheck: true }));
  });
}

/** Prueba directamente los rangos y las direcciones de la ruta, incluidos valores que JavaScript ya rechaza. */
test("el circuito rechaza nonce nulo o grande, fuente cero e índices Merkle no booleanos", async (t) => {
  t.mock.method(console, "error", /* Mantiene limpia la salida de los casos deliberadamente inválidos. */ () => {});
  const cases = [
    { ...fixture.inputs, nonce: "0" }, { ...fixture.inputs, nonce: NONCE_LIMIT.toString() },
    { ...fixture.inputs, sourceId: "0" }, { ...fixture.inputs, chainId: "0" },
    { ...fixture.inputs, chainId: (1n << 64n).toString() },
    { ...fixture.inputs, registrant: (1n << 160n).toString() },
    { ...fixture.inputs, registryAddress: (1n << 160n).toString() },
    { ...fixture.inputs, merklePathIndices: ["2", ...fixture.inputs.merklePathIndices.slice(1)] },
    { ...fixture.inputs, merklePathElements: [(BigInt(fixture.inputs.merklePathElements[0]) + 1n).toString(), ...fixture.inputs.merklePathElements.slice(1)] },
    { ...fixture.inputs, merklePathIndices: [(1n - BigInt(fixture.inputs.merklePathIndices[0])).toString(), ...fixture.inputs.merklePathIndices.slice(1)] },
  ];
  for (const input of cases) await assert.rejects(wtns.calculate(input, artifactPaths().wasm, { type: "mem" }, { sanityCheck: true }));
});

/** Una clave diferente y una fuente no incluida en la raíz no pueden satisfacer la firma y la pertenencia. */
test("el circuito rechaza una clave incorrecta y una fuente no autorizada", async (t) => {
  t.mock.method(console, "error", /* Oculta las aserciones que deben fallar durante la prueba negativa. */ () => {});
  await assert.rejects(wtns.calculate({ ...fixture.inputs, publicKeyX: fixture.otherKey[0].toString(), publicKeyY: fixture.otherKey[1].toString() }, artifactPaths().wasm, { type: "mem" }, { sanityCheck: true }));
  const seed = privateKeyFromHex("24".repeat(32));
  const publicKey = await derivePublicKey(seed);
  const ownTree = await buildAuthorizedSourcesTree([{ sourceId: 3n, publicKey }]);
  const authorization = await signContentAuthorization({ contentHash: fixture.inputs.contentHash, ...vector.operation, sourceId: 3n, nonce: generateNonce() }, seed);
  const ownInputs = await createProofInputs(authorization, await getSourceProof(ownTree, 3n));
  await assert.rejects(wtns.calculate({ ...ownInputs, authorizedSourcesRoot: fixture.inputs.authorizedSourcesRoot }, artifactPaths().wasm, { type: "mem" }, { sanityCheck: true }));
  await assert.rejects(createProofInputs(authorization, fixture.membership));
  seed.fill(0);
});

/** Produce una prueba con el testigo real y comprueba que alterar una señal pública invalida su verificación. */
test("Groth16 genera y verifica una prueba real vinculada a las ocho señales públicas", { timeout: 120000 }, async () => {
  const result = await generateProof(fixture.inputs);
  assert.equal(await verifyProof(result.proof, result.publicSignals), true);
  assert.deepEqual(result.publicSignals, publicSignalsFromInput(fixture.inputs));
  assert.equal(result.publicSignals.length, 8);
  assert.ok(result.metrics.proofBytes > 0);
  assert.ok(result.metrics.proveMs > 0);
  assert.equal(Object.hasOwn(result, "inputs"), false);
  assert.equal(Object.hasOwn(result, "witness"), false);
  const modified = [...result.publicSignals];
  modified[0] = (BigInt(modified[0]) + 1n).toString();
  assert.equal(await verifyProof(result.proof, modified), false);
  const badProof = structuredClone(result.proof);
  badProof.pi_a[0] = (BigInt(badProof.pi_a[0]) + 1n).toString();
  assert.equal(await verifyProof(badProof, result.publicSignals), false);
});

/** Rechaza la mezcla de parámetros y detecta una clave de verificación alterada mediante su huella de artefacto. */
test("el manifiesto detecta artefactos incompatibles o manipulados", async () => {
  const directory = await temporaryDirectory("artifacts-");
  try {
    await cp(artifactPaths().root, directory, { recursive: true });
    const keyPath = artifactPaths({ artifactsDir: directory }).verificationKey;
    await writeFile(keyPath, (await readFile(keyPath, "utf8")) + "\n");
    await assert.rejects(ensureZkArtifacts({ artifactsDir: directory }), /alterado|incompatible/);
    const manifest = structuredClone(fixture.manifest);
    manifest.parameters.merkleDepth = 7;
    await writeFile(path.join(directory, "manifest.json"), stringifyCrypto(manifest));
    await assert.rejects(ensureZkArtifacts({ artifactsDir: directory }), /Parámetros/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

/** Mantiene coherentes los controles públicos del adaptador con los rangos y constantes del circuito. */
test("la serialización pública rechaza cadena inválida, versión y dominio no admitidos", () => {
  for (const chainId of ["0", (1n << 64n).toString()]) assert.throws(/* Prueba un identificador de cadena fuera del rango v1. */ () => publicSignalsFromInput({ ...fixture.inputs, chainId }));
  assert.throws(/* Prueba una versión que no corresponde al circuito. */ () => publicSignalsFromInput({ ...fixture.inputs, protocolVersion: "2" }));
  assert.throws(/* Prueba otro dominio de protocolo. */ () => publicSignalsFromInput({ ...fixture.inputs, protocolDomain: "0" }));
});
