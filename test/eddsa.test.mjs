/** Prueba las firmas, las claves de fuente, la serialización y los paquetes de autorización. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { derivePublicKey, deserializeSignature, exportVerifierInputs, normalizeSignature, serializeSignature, signAuthorizationHash, validatePublicKey, verifyAuthorizationSignature } from "../src/eddsa.mjs";
import { FIELD_MODULUS, SUBGROUP_ORDER } from "../src/encoding.mjs";
import { generatePrivateKey, loadPrivateKey, privateKeyFromHex, savePrivateKey, validatePrivateKey } from "../src/key-management.mjs";
import { deserializeAuthorizationPackage, exportProverInputs, serializeAuthorizationPackage, signContentAuthorization, verifyContentAuthorization } from "../src/authorization.mjs";
import { testSeed, temporaryDirectory, vector } from "./fixtures.mjs";

/** Comprueba la derivación de la clave pública y la firma contra el vector de referencia. */
test("deriva la clave pública y firma determinista del vector", async () => {
  assert.deepEqual((await derivePublicKey(testSeed())).map(String), vector.publicKey);
  const signature = await signAuthorizationHash(vector.signedAuthorizationHash, testSeed());
  assert.deepEqual(JSON.parse(await serializeSignature(signature)), vector.signature);
  assert.equal(await verifyAuthorizationSignature(vector.signedAuthorizationHash, signature, vector.publicKey), true);
  assert.deepEqual(await signAuthorizationHash(vector.signedAuthorizationHash, testSeed()), signature);
});

/** Altera por separado el mensaje y el escalar para exigir el rechazo de la firma. */
test("rechaza un mensaje o escalar de firma modificado", async () => {
  assert.equal(await verifyAuthorizationSignature(BigInt(vector.signedAuthorizationHash) + 1n, vector.signature, vector.publicKey), false);
  assert.equal(await verifyAuthorizationSignature(vector.signedAuthorizationHash, { ...vector.signature, S: BigInt(vector.signature.S) + 1n }, vector.publicKey), false);
});

/** Verifica que la clave de otra fuente no autentique la firma original. */
test("rechaza una clave pública incorrecta", async () => {
  const other = await derivePublicKey(privateKeyFromHex("42".repeat(32)));
  assert.equal(await verifyAuthorizationSignature(vector.signedAuthorizationHash, vector.signature, other), false);
});

/** Comprueba la ida y vuelta por JSON y rechaza escalares mal representados. */
test("serializa y deserializa sin pérdida de precisión", async () => {
  const signature = await deserializeSignature(JSON.stringify(vector.signature));
  assert.equal(typeof signature.S, "bigint");
  assert.deepEqual(await deserializeSignature(await serializeSignature(signature)), signature);
  await assert.rejects(deserializeSignature(JSON.stringify({ ...vector.signature, S: 1 })), /cadenas/);
  await assert.rejects(deserializeSignature(JSON.stringify({ ...vector.signature, S: "01" })));
});

/** Prueba coordenadas fuera de curva o subgrupo y escalares inválidos. */
test("rechaza puntos inválidos, neutros, torsión y escalares no canónicos", async () => {
  for (const point of [[0n, 0n], [0n, 1n], [0n, FIELD_MODULUS - 1n], [FIELD_MODULUS, 1n], ["01", "1"], [1n]]) {
    await assert.rejects(validatePublicKey(point));
    await assert.rejects(normalizeSignature({ R8: point, S: 1n }));
  }
  for (const scalar of [-1n, SUBGROUP_ORDER, FIELD_MODULUS, 1, "01"]) {
    await assert.rejects(normalizeSignature({ ...vector.signature, S: scalar }));
  }
  await assert.rejects(normalizeSignature({ ...vector.signature, extra: true }));
});

/** Contrasta los campos exportados con los nombres y valores esperados por el circuito. */
test("exporta nombres y cadenas compatibles con EdDSAPoseidonVerifier", async () => {
  const inputs = await exportVerifierInputs(vector.signedAuthorizationHash, vector.signature, vector.publicKey);
  assert.deepEqual(inputs, {
    enabled: "1", Ax: vector.publicKey[0], Ay: vector.publicKey[1], R8x: vector.signature.R8[0],
    R8y: vector.signature.R8[1], S: vector.signature.S, M: vector.signedAuthorizationHash,
  });
  await assert.rejects(exportVerifierInputs(1n, vector.signature, vector.publicKey), /inválida/);
});

/** Comprueba el tamaño, la independencia y la copia de las semillas generadas. */
test("genera semillas de 32 bytes independientes", () => {
  const first = generatePrivateKey();
  const second = generatePrivateKey();
  assert.equal(first.length, 32);
  assert.notDeepEqual(first, second);
  const copy = validatePrivateKey(first);
  copy.fill(0);
  assert.notDeepEqual(copy, first);
});

/** Prueba el rechazo de semillas nulas, tamaños incorrectos y texto hexadecimal inválido. */
test("valida semillas y rechaza claves PEM/EVM mal codificadas", () => {
  for (const value of [new Uint8Array(32), new Uint8Array(31), "abc", null]) assert.throws(/* Ejecuta la validación de una semilla que debe ser rechazada. */ () => validatePrivateKey(value));
  for (const value of ["0x" + "42".repeat(32), "AB".repeat(32), "00".repeat(32), "42".repeat(31)]) assert.throws(/* Intenta decodificar una clave de texto inválida. */ () => privateKeyFromHex(value));
});

/** Comprueba los archivos de claves, la carga por entorno y la protección frente a sobrescritura. */
test("guarda y carga secretos sin sobrescribir ni aceptar fuentes ambiguas", async () => {
  const directory = await temporaryDirectory("keys-");
  try {
    const path = join(directory, "source-private.json");
    await savePrivateKey(path, testSeed());
    assert.deepEqual(await loadPrivateKey({ filePath: path, env: {} }), testSeed());
    assert.deepEqual(await loadPrivateKey({ env: { SOURCE_EDDSA_PRIVATE_KEY: vector.testOnlyPrivateSeedHex } }), testSeed());
    await assert.rejects(savePrivateKey(path, generatePrivateKey()), { code: "EEXIST" });
    await assert.rejects(loadPrivateKey({ filePath: path, env: { SOURCE_EDDSA_PRIVATE_KEY: vector.testOnlyPrivateSeedHex } }), /solo un origen/);
    await assert.rejects(loadPrivateKey({ env: {} }), /Falta/);
    const record = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...record, format: "ed25519" }));
    await assert.rejects(loadPrivateKey({ filePath: path, env: {} }), /incompatible/);
    await writeFile(path, "{confidential-invalid-json");
    await assert.rejects(loadPrivateKey({ filePath: path, env: {} }), /* Exige un mensaje de error que no revele el contenido del archivo privado. */ (error) => error.message === "Archivo de clave inválido");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Datos de autorización usados para probar el paquete completo con el vector determinista.
const input = { contentHash: vector.contentHashes[62], ...vector.operation };
// Valores de confianza que el verificador recibe por separado del paquete firmado.
const expected = { contentHash: input.contentHash, operation: vector.operation, publicKey: vector.publicKey };

/** Valida la autorización con datos esperados y una clave de confianza suministrados por separado. */
test("el paquete se verifica contra la fuente y operación de confianza", async () => {
  const signed = await signContentAuthorization(input, testSeed());
  const restored = await deserializeAuthorizationPackage(await serializeAuthorizationPackage(signed));
  assert.equal(await verifyContentAuthorization(restored, expected), true);
  assert.equal(await verifyContentAuthorization(restored, { ...expected, contentHash: 2n }), false);
  for (const [key, changed] of Object.entries({ registrant: "0x" + "33".repeat(20), chainId: "80002", registryAddress: "0x" + "44".repeat(20), protocolDomain: "2" })) {
    const operation = { ...vector.operation, context: { ...vector.operation.context, [key]: changed } };
    assert.equal(await verifyContentAuthorization(restored, { ...expected, operation }), false);
  }
  const otherKey = await derivePublicKey(privateKeyFromHex("42".repeat(32)));
  assert.equal(await verifyContentAuthorization(restored, { ...expected, publicKey: otherKey }), false);
  await assert.rejects(verifyContentAuthorization(restored, { ...expected, operation: { ...vector.operation, contentHash: input.contentHash } }), /estructura/);
});

/** Modifica el paquete y exige que se detecten las inconsistencias entre sus datos y huellas. */
test("rechaza paquetes inconsistentes y números JSON", async () => {
  const record = JSON.parse(await serializeAuthorizationPackage(await signContentAuthorization(input, testSeed())));
  for (const key of ["authorizationHash", "operationContext", "signedAuthorizationHash", "nonce"]) {
    const changed = structuredClone(record);
    changed.authorization[key] = (BigInt(changed.authorization[key]) + 1n).toString();
    await assert.rejects(deserializeAuthorizationPackage(JSON.stringify(changed)), /inconsistente/);
  }
  const invalid = structuredClone(record);
  invalid.authorization.nonce = 1;
  await assert.rejects(deserializeAuthorizationPackage(JSON.stringify(invalid)), /cadenas/);
  await assert.rejects(deserializeAuthorizationPackage(JSON.stringify({ ...record, secret: "no" })), /estructura/);
});

/** Comprueba que las entradas del circuito usen texto decimal y no incluyan la semilla privada. */
test("el generador de pruebas recibe firma y datos auxiliares, sin semilla privada", async () => {
  const inputs = await exportProverInputs(await signContentAuthorization(input, testSeed()));
  assert.equal(inputs.M, vector.signedAuthorizationHash);
  assert.equal(inputs.authorizationHash, vector.authorizationHash);
  assert.equal(inputs.operationContext, vector.operationContext);
  assert.equal(inputs.registrant, BigInt(vector.operation.context.registrant).toString());
  assert.ok(Object.values(inputs).every(/* Exige que cada entrada sea una cadena decimal canónica. */ (value) => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)));
  assert.doesNotMatch(JSON.stringify(inputs), /private|seed/i);
});
