/** Prueba los comandos del proyecto y su compatibilidad con el circuito de verificación de Circom. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import path, { join, relative } from "node:path";
import { CircomRunner, bindings } from "circom2";
import { wtns } from "snarkjs";
import { exportProverInputs, signContentAuthorization } from "../src/authorization.mjs";
import { bytes, testSeed, temporaryDirectory, vector } from "./fixtures.mjs";

/** Compila el circuito de ensayo a WASM y R1CS usando rutas nativas compatibles con Windows. */
async function compileCircuit(directory) {
  const require = createRequire(import.meta.url);
  const runner = new CircomRunner({
    args: ["test/circuits/authorization.circom", "--r1cs", "--wasm", "--sym", "-l", "node_modules", "-o", relative(process.cwd(), directory).replaceAll("\\", "/")],
    env: {},
    preopens: { ".": process.cwd() },
    bindings: { ...bindings, fs, path },
  });
  await runner.execute(fs.readFileSync(require.resolve("circom2/circom.wasm")));
}

/** Ejecuta el CLI en otro proceso con un entorno controlado y devuelve su salida y código de terminación. */
function command(action, args = [], extraEnvironment = {}) {
  const env = { ...process.env, ...extraEnvironment };
  if (!Object.hasOwn(extraEnvironment, "SOURCE_EDDSA_PRIVATE_KEY")) delete env.SOURCE_EDDSA_PRIVATE_KEY;
  return spawnSync(process.execPath, ["scripts/crypto-cli.mjs", ...(action ? [action] : []), ...args], { encoding: "utf8", timeout: 60000, env });
}
/** Exige que un comando termine correctamente y devuelve el resultado para comprobar su salida. */
function successful(result) {
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result;
}

/** Comprueba el flujo completo del CLI, incluida la firma por entorno y el rechazo de un archivo modificado. */
test("los comandos generan claves, hash, autorización, firma, verificación y inputs", async () => {
  const directory = await temporaryDirectory("cli-");
  try {
    const file = join(directory, "content.bin");
    const privatePath = join(directory, "source-private.json");
    const publicPath = join(directory, "source-public.json");
    const authorization = join(directory, "authorization.json");
    const witness = join(directory, "witness.json");
    await writeFile(file, bytes(62));
    const keygen = successful(command("keygen", ["--out", privatePath, "--public-key", publicPath]));
    const seed = JSON.parse(await readFile(privatePath, "utf8")).seed;
    assert.ok(!keygen.stdout.includes(seed) && !keygen.stderr.includes(seed));
    assert.equal(JSON.parse(successful(command("hash", ["--file", file])).stdout).contentHash, vector.contentHashes[62]);
    const opArgs = ["--file", file, "--operation", "samples/operation.json"];
    const auth = JSON.parse(successful(command("authorization", opArgs)).stdout);
    assert.equal(auth.signedAuthorizationHash, vector.signedAuthorizationHash);
    successful(command("sign", [...opArgs, "--key", privatePath, "--out", authorization]));
    const fromEnv = successful(command("sign", opArgs, { SOURCE_EDDSA_PRIVATE_KEY: seed }));
    assert.deepEqual(JSON.parse(fromEnv.stdout), JSON.parse(await readFile(authorization, "utf8")));
    assert.ok(!fromEnv.stdout.includes(seed));
    assert.equal(command("sign", [...opArgs, "--key", privatePath], { SOURCE_EDDSA_PRIVATE_KEY: seed }).status, 1);
    const verifyArgs = [...opArgs, "--authorization", authorization, "--public-key", publicPath];
    assert.equal(JSON.parse(successful(command("verify", [...verifyArgs, "--witness", witness])).stdout).valid, true);
    const inputs = JSON.parse(await readFile(witness, "utf8"));
    assert.equal(inputs.M, vector.signedAuthorizationHash);
    assert.ok(!JSON.stringify(inputs).includes(seed));
    const changed = bytes(62);
    changed[0] ^= 1;
    await writeFile(file, changed);
    const invalid = command("verify", verifyArgs);
    assert.equal(invalid.status, 2, invalid.stderr);
    assert.equal(JSON.parse(invalid.stdout).valid, false);
    assert.equal(command("keygen", ["--out", privatePath, "--public-key", publicPath]).status, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** Comprueba la ayuda, los comandos desconocidos y los argumentos obligatorios. */
test("los comandos validan argumentos y ofrecen ayuda ejecutable", () => {
  for (const action of ["hash", "keygen", "authorization", "sign", "verify"]) {
    assert.match(successful(command(action, ["--help"])).stdout, /Uso:/);
    assert.equal(command(action, ["--unknown"]).status, 1);
  }
  assert.match(successful(command(undefined, ["--help"])).stdout, /Uso:/);
  assert.equal(command().status, 1);
  assert.equal(command("unknown").status, 1);
  assert.equal(command("hash").status, 1);
  assert.equal(command("sign", ["--file", "samples/prueba.txt", "--operation", "samples/operation.json"]).status, 1);
});

/** Genera y valida un testigo real, y exige que Circom rechace cambios de firma, mensaje o contexto. */
test("Circom acepta el testigo real y rechaza alteraciones de firma, mensaje y contexto", { timeout: 180000 }, async (t) => {
  const directory = await temporaryDirectory("circom-");
  try {
    await compileCircuit(directory);
    const wasm = join(directory, "authorization_js", "authorization.wasm");
    const r1cs = join(directory, "authorization.r1cs");
    const witness = join(directory, "authorization.wtns");
    const record = await signContentAuthorization({ contentHash: vector.contentHashes[62], ...vector.operation }, testSeed());
    const inputs = await exportProverInputs(record);
    await wtns.calculate(inputs, wasm, witness);
    const checked = spawnSync(process.execPath, ["node_modules/snarkjs/build/cli.cjs", "wtns", "check", r1cs, witness], {
      encoding: "utf8", timeout: 60000,
    });
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    // Se conserva este texto literal porque es la respuesta emitida por snarkjs.
    assert.match(checked.stdout, /WITNESS IS CORRECT/);
    assert.ok((await readFile(witness)).byteLength > 0);
    t.mock.method(console, "error", /* Silencia los mensajes esperados al probar restricciones inválidas. */ () => {});
    for (const key of ["S", "M", "registrant", "chainId", "registryAddress", "protocolDomain", "authorizationHash", "operationContext"]) {
      await assert.rejects(wtns.calculate({ ...inputs, [key]: (BigInt(inputs[key]) + 1n).toString() }, wasm, { type: "mem" }));
    }
    await assert.rejects(wtns.calculate({ ...inputs, enabled: "0" }, wasm, { type: "mem" }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
