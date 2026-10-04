/** Ofrece los comandos para calcular huellas, generar claves, crear autorizaciones, firmarlas y verificarlas. */

import { parseArgs } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { calculateContentHash } from "../src/hashing.mjs";
import { createAuthorization, deserializeAuthorizationPackage, exportProverInputs, serializeAuthorizationPackage, signContentAuthorization, verifyContentAuthorization } from "../src/authorization.mjs";
import { exactKeys, stringifyCrypto } from "../src/encoding.mjs";
import { derivePublicKey } from "../src/eddsa.mjs";
import { generatePrivateKey, loadPrivateKey, savePrivateKey } from "../src/key-management.mjs";

// Opciones permitidas por cada comando; parseArgs rechaza cualquier parámetro desconocido.
const definitions = {
  hash: ["file"], keygen: ["out", "public-key"],
  authorization: ["file", "operation", "out"],
  sign: ["file", "operation", "key", "out"],
  verify: ["file", "operation", "authorization", "public-key", "witness"],
};
// Sintaxis de ayuda para ejecutar cada comando con sus parámetros.
const usages = {
  hash: "--file <archivo>",
  keygen: "[--out keys/source-private.json] [--public-key keys/source-public.json]",
  authorization: "--file <archivo> --operation <operacion.json> [--out <salida.json>]",
  sign: "--file <archivo> --operation <operacion.json> [--key <clave.json>] [--out <firma.json>]",
  verify: "--file <archivo> --operation <operacion.json> --authorization <firma.json> --public-key <publica.json> [--witness <inputs.json>]",
};

/** Lee un archivo JSON en UTF-8 y evita incluir su contenido en los errores de sintaxis. */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new TypeError("Archivo JSON inválido");
    throw error;
  }
}

/** Crea las carpetas necesarias y guarda la salida sin reemplazar un archivo existente. */
async function writeOutput(path, text) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, text + "\n", { flag: "wx" });
}

/** Exige una opción del comando y devuelve su valor, o indica cuál parámetro falta. */
function required(values, name) {
  if (!values[name]) throw new TypeError(`Falta --${name}`);
  return values[name];
}

/** Ejecuta el comando solicitado: código 0 al completar, 1 ante errores y 2 si la autorización no verifica. */
async function run(command, args) {
  try {
    if (command === "--help") {
      console.log("Uso: node scripts/crypto-cli.mjs <hash|keygen|authorization|sign|verify> [opciones]");
      return;
    }
    if (!Object.hasOwn(definitions, command)) {
      throw new TypeError("Falta un comando válido: hash, keygen, authorization, sign o verify");
    }
    const options = Object.fromEntries(definitions[command].map(/* Declara cada opción admitida como una cadena de texto. */ (name) => [name, { type: "string" }]));
    options.help = { type: "boolean" };
    const { values } = parseArgs({ args, options, strict: true });
    if (values.help) {
      console.log(`Uso: ${command} ${usages[command]}`);
      return;
    }
    if (command === "keygen") {
      const privatePath = values.out ?? "keys/source-private.json";
      const publicPath = values["public-key"] ?? "keys/source-public.json";
      if (resolve(privatePath) === resolve(publicPath)) throw new Error("Las rutas de claves deben ser diferentes");
      const seed = generatePrivateKey();
      try {
        const publicKey = await derivePublicKey(seed);
        await mkdir(dirname(resolve(privatePath)), { recursive: true });
        await savePrivateKey(privatePath, seed);
        await writeOutput(publicPath, stringifyCrypto(publicKey));
        console.log(stringifyCrypto({ privateKeyFile: privatePath, publicKeyFile: publicPath }));
      } finally {
        seed.fill(0);
      }
      return;
    }
    const contentHash = await calculateContentHash(required(values, "file"));
    if (command === "hash") {
      console.log(stringifyCrypto({ contentHash }));
      return;
    }
    const operation = await readJson(required(values, "operation"));
    exactKeys(operation, ["protocolVersion", "sourceId", "nonce", "context"], "operation");
    if (command === "verify") {
      const authorization = await deserializeAuthorizationPackage(await readFile(required(values, "authorization"), "utf8"));
      const publicKey = await readJson(required(values, "public-key"));
      const valid = await verifyContentAuthorization(authorization, { contentHash, operation, publicKey });
      if (valid && values.witness) await writeOutput(values.witness, stringifyCrypto(await exportProverInputs(authorization)));
      console.log(stringifyCrypto({ valid, contentHash }));
      if (!valid) process.exitCode = 2;
      return;
    }
    let output;
    if (command === "authorization") {
      output = stringifyCrypto(await createAuthorization({ contentHash, ...operation }));
    } else {
      const seed = await loadPrivateKey({ filePath: values.key });
      try {
        output = await serializeAuthorizationPackage(await signContentAuthorization({ contentHash, ...operation }, seed));
      } finally {
        seed.fill(0);
      }
    }
    if (values.out) await writeOutput(values.out, output);
    else console.log(output);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

await run(process.argv[2], process.argv.slice(3));
