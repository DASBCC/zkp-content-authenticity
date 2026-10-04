/** Prueba las huellas de contenido y el vínculo de las autorizaciones con sus datos y su contexto. */

import test from "node:test";
import assert from "node:assert/strict";
import { open, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { calculateContentHash, hashContentBytes, hashContentStream } from "../src/hashing.mjs";
import { poseidonHash } from "../src/poseidon.mjs";
import { calculateAuthorizationHash, calculateSignedAuthorizationHash, createAuthorization, PROTOCOL_DOMAIN } from "../src/authorization.mjs";
import { canonicalAddress, FIELD_MODULUS, parseField } from "../src/encoding.mjs";
import { bytes, temporaryDirectory, vector } from "./fixtures.mjs";

for (const length of [0, 1, 30, 31, 32, 62]) {
  /** Compara bytes, fragmentos y lectura de archivo contra el mismo vector determinista. */
  test(`contentHash reproduce el vector de ${length} bytes`, async () => {
    const value = bytes(length);
    const expected = BigInt(vector.contentHashes[length]);
    assert.equal(await hashContentBytes(value), expected);
    assert.equal(await hashContentBytes(value), expected);
    assert.equal(await hashContentStream(Array.from(value, /* Crea un fragmento de un solo octeto para probar los cortes del flujo. */ (byte) => Uint8Array.of(byte)), BigInt(length)), expected);
    const directory = await temporaryDirectory("hash-");
    try {
      const path = join(directory, "binary.dat");
      await writeFile(path, value);
      assert.equal(await calculateContentHash(path), expected);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

/** Comprueba la construcción fijada para un archivo sin bytes. */
test("el archivo vacío es exactamente Poseidon(0,0)", async () => {
  assert.equal(await hashContentBytes(new Uint8Array()), await poseidonHash([0n, 0n]));
});

/** Verifica el relleno con ceros y que la longitud diferencie archivos con ceros finales. */
test("el relleno va a la derecha y la longitud evita equivalencias con ceros añadidos", async () => {
  const padded = 0xabn << 240n;
  assert.equal(await hashContentBytes(Uint8Array.of(0xab)), await poseidonHash([1n, padded]));
  const full = new Uint8Array(31);
  full[0] = 0xab;
  assert.equal(await hashContentBytes(full), await poseidonHash([31n, padded]));
  assert.notEqual(await hashContentBytes(full), await hashContentBytes(Uint8Array.of(0xab)));
  assert.notEqual(await hashContentBytes(Uint8Array.of(0)), await hashContentBytes(new Uint8Array()));
});

/** Comprueba que cambiar un solo octeto altere la huella. */
test("modificar un solo byte modifica contentHash", async () => {
  const original = bytes(62);
  const changed = original.slice();
  changed[31] ^= 1;
  assert.notEqual(await hashContentBytes(original), await hashContentBytes(changed));
});

/** Prueba diferentes cortes del flujo y evita un bloque adicional en múltiplos de 31. */
test("los límites de los fragmentos no alteran la huella ni agregan un bloque a múltiplos de 31", async () => {
  const input = bytes(62);
  const first = BigInt("0x" + Buffer.from(input.subarray(0, 31)).toString("hex"));
  const second = BigInt("0x" + Buffer.from(input.subarray(31)).toString("hex"));
  const expected = await poseidonHash([await poseidonHash([62n, first]), second]);
  for (const cut of [1, 17, 30, 31, 32, 61]) {
    assert.equal(await hashContentStream([input.subarray(0, cut), new Uint8Array(), input.subarray(cut)], 62n), expected);
  }
});

/** Rechaza flujos cuya longitud o tipo no coincidan con el contrato de entrada. */
test("rechaza flujos de bytes con longitud o tipos inconsistentes", async () => {
  await assert.rejects(hashContentStream([bytes(1)], 0n), /fileLength/);
  await assert.rejects(hashContentStream([bytes(1)], 2n), /fileLength/);
  await assert.rejects(hashContentStream(["abc"], 3n), /Uint8Array/);
  await assert.rejects(hashContentBytes("abc"), /Uint8Array/);
});

/** Compara la lectura incremental de un archivo grande con un flujo generado por bloques. */
test("procesa un archivo de más de 2 MiB en búferes de 64 KiB", async () => {
  const directory = await temporaryDirectory("large-");
  try {
    const path = join(directory, "large.bin");
    const handle = await open(path, "wx");
    const chunk = bytes(64 * 1024);
    const tail = bytes(17);
    try {
      for (let index = 0; index < 32; index++) await handle.write(chunk);
      await handle.write(tail);
    } finally {
      await handle.close();
    }
    /** Produce los mismos bloques escritos en el archivo grande para comparar ambos modos de cálculo de huellas. */
    async function* generated() {
      for (let index = 0; index < 32; index++) yield chunk;
      yield tail;
    }
    const expected = await hashContentStream(generated(), 2097169n);
    assert.equal(await calculateContentHash(path), expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Autorización base de referencia para comprobar cada campo sin cambiar los demás.
const base = { contentHash: vector.contentHashes[62], protocolVersion: "1", sourceId: "1", nonce: "1" };

/** Reproduce las tres huellas de autorización del vector y comprueba el dominio. */
test("la autorización reproduce exactamente los tres hashes del vector", async () => {
  const value = await createAuthorization({ ...base, context: vector.operation.context });
  assert.equal(value.authorizationHash.toString(), vector.authorizationHash);
  assert.equal(value.operationContext.toString(), vector.operationContext);
  assert.equal(value.signedAuthorizationHash.toString(), vector.signedAuthorizationHash);
  assert.equal(await calculateAuthorizationHash(base), await calculateAuthorizationHash(base));
  assert.equal(await calculateSignedAuthorizationHash(value.authorizationHash, vector.operation.context), value.signedAuthorizationHash);
  assert.equal(PROTOCOL_DOMAIN.toString(), vector.operation.context.protocolDomain);
});

for (const key of Object.keys(base)) {
  /** Modifica cada campo base para comprobar que queda comprometido por Poseidon. */
  test(`authorizationHash vincula ${key}`, async () => {
    assert.notEqual(await calculateAuthorizationHash(base), await calculateAuthorizationHash({ ...base, [key]: BigInt(base[key]) + 1n }));
  });
}

for (const [key, changed] of Object.entries({
  registrant: "0x3333333333333333333333333333333333333333", chainId: "80002",
  registryAddress: "0x4444444444444444444444444444444444444444", protocolDomain: "2",
})) {
  /** Modifica cada dato del contexto y comprueba que cambia el mensaje firmado. */
  test(`el mensaje firmado vincula ${key} sin alterar la autorización base`, async () => {
    const original = await createAuthorization({ ...base, context: vector.operation.context });
    const other = await createAuthorization({ ...base, context: { ...vector.operation.context, [key]: changed } });
    assert.equal(original.authorizationHash, other.authorizationHash);
    assert.notEqual(original.signedAuthorizationHash, other.signedAuthorizationHash);
  });
}

/** Prueba valores fuera del campo y representaciones que podrían perder precisión. */
test("rechaza valores de campo no canónicos, números JS y datos fuera del campo", async () => {
  for (const invalid of [1, 1.5, NaN, Infinity, -1n, FIELD_MODULUS, "01", "0x01", "+1", "-1", " 1", "1 ", "1e3", "", null, true]) {
    assert.throws(/* Intenta convertir un valor de campo inválido. */ () => parseField(invalid));
    await assert.rejects(calculateAuthorizationHash({ ...base, nonce: invalid }));
  }
  assert.equal(parseField("0"), 0n);
  assert.equal(parseField(FIELD_MODULUS - 1n), FIELD_MODULUS - 1n);
  await assert.rejects(calculateAuthorizationHash({ ...base, registrant: vector.operation.context.registrant }), /estructura/);
});

/** Comprueba el formato de las direcciones y que el identificador de red sea positivo. */
test("el contexto exige direcciones de 20 bytes y chainId positivo", async () => {
  for (const value of ["0x1", "1", 1n, "0x" + "f".repeat(41)]) {
    assert.throws(/* Intenta normalizar una dirección de longitud o formato incorrectos. */ () => canonicalAddress(value, "address"));
  }
  assert.equal(canonicalAddress("0x" + "aB".repeat(20), "address"), "0x" + "ab".repeat(20));
  await assert.rejects(createAuthorization({ ...base, context: { ...vector.operation.context, chainId: "0" } }));
  await assert.rejects(createAuthorization({ ...base, context: { ...vector.operation.context, chainId: undefined } }));
});
