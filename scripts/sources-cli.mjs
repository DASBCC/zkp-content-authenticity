/** Administra archivos locales de fuentes autorizadas y genera raíces y rutas Merkle compatibles con el circuito. */

import { parseArgs } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseField, stringifyCrypto } from "../src/encoding.mjs";
import {
  addAuthorizedSource, buildAuthorizedSourcesTree, getSourceProof,
  revokeAuthorizedSource, updateAuthorizedSource, verifySourceProof,
} from "../src/merkle.mjs";

// Cada operación admite únicamente las opciones que necesita y rechaza las demás.
const OPTIONS = {
  build: ["sources", "out"],
  add: ["sources", "source-id", "public-key", "out"],
  update: ["sources", "source-id", "public-key", "out"],
  revoke: ["sources", "source-id", "out"],
  proof: ["sources", "source-id", "out"],
  verify: ["input"],
};
// Sintaxis de los comandos; las salidas privadas siempre requieren un archivo explícito.
const USAGE = {
  build: "--sources <fuentes.json> [--out <raiz-publica.json>]",
  add: "--sources <fuentes.json> --source-id <decimal> --public-key <publica.json> --out <fuentes-nuevas.json>",
  update: "--sources <fuentes.json> --source-id <decimal> --public-key <publica.json> --out <fuentes-nuevas.json>",
  revoke: "--sources <fuentes.json> --source-id <decimal> --out <fuentes-nuevas.json>",
  proof: "--sources <fuentes.json> --source-id <decimal> --out <ruta-privada.json>",
  verify: "--input <ruta-privada.json>",
};

/** Exige una opción de texto no vacía y devuelve su valor. */
function required(values, name) {
  if (!values[name]) throw new TypeError(`Falta --${name}`);
  return values[name];
}

/** Lee datos JSON sin exponer su contenido cuando el archivo tiene errores de sintaxis. */
async function readJson(filename) {
  try { return JSON.parse(await readFile(filename, "utf8")); }
  catch (error) {
    if (error instanceof SyntaxError) throw new TypeError("El archivo JSON no es válido");
    throw error;
  }
}

/** Escribe un archivo nuevo, solicita permisos 0600 y evita sobrescribir conjuntos o rutas existentes. */
async function writeNewJson(filename, value) {
  const destination = resolve(filename);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, stringifyCrypto(value) + "\n", { flag: "wx", mode: 0o600 });
}

/** Convierte el identificador decimal de la fuente a un BigInt positivo del campo. */
function sourceIdFromOptions(values) {
  const sourceId = parseField(required(values, "source-id"), "sourceId");
  if (sourceId === 0n) throw new RangeError("sourceId debe ser positivo");
  return sourceId;
}

/** Extrae solamente la información pública de un árbol sin publicar fuentes, claves ni hermanos. */
function publicSummary(tree) {
  return { root: tree.root, depth: tree.depth, count: tree.sources.length };
}

/** Ejecuta la operación local solicitada y asigna los códigos 0, 1 o 2 según su resultado. */
async function run(command, args) {
  try {
    if (command === "--help") {
      console.log("Uso: node scripts/sources-cli.mjs <build|add|update|revoke|proof|verify> [opciones]");
      return;
    }
    if (!Object.hasOwn(OPTIONS, command)) throw new TypeError("Falta un comando válido: build, add, update, revoke, proof o verify");
    const options = { help: { type: "boolean" } };
    for (const name of OPTIONS[command]) options[name] = { type: "string" };
    let values;
    try { ({ values } = parseArgs({ args, options, strict: true, allowPositionals: false })); }
    catch { throw new TypeError("Opciones inválidas; usa --help para consultar los parámetros permitidos"); }
    if (values.help) {
      console.log(`Uso: ${command} ${USAGE[command]}`);
      return;
    }
    if (command === "verify") {
      const valid = await verifySourceProof(await readJson(required(values, "input")));
      console.log(stringifyCrypto({ valid }));
      if (!valid) process.exitCode = 2;
      return;
    }
    // Las rutas y los conjuntos contienen la identidad de las fuentes y no se imprimen en la consola.
    const output = command === "build" ? values.out : required(values, "out");
    const sources = await readJson(required(values, "sources"));
    if (command === "build") {
      const summary = publicSummary(await buildAuthorizedSourcesTree(sources));
      if (output) await writeNewJson(output, summary);
      console.log(stringifyCrypto(summary));
      return;
    }
    const sourceId = sourceIdFromOptions(values);
    if (command === "proof") {
      const proof = await getSourceProof(await buildAuthorizedSourcesTree(sources), sourceId);
      await writeNewJson(output, proof);
      console.log(stringifyCrypto({ proofFile: output, root: proof.root }));
      return;
    }
    let updated;
    if (command === "revoke") updated = await revokeAuthorizedSource(sources, sourceId);
    else {
      const publicKey = await readJson(required(values, "public-key"));
      const entry = { sourceId, publicKey };
      updated = command === "add"
        ? await addAuthorizedSource(sources, entry)
        : await updateAuthorizedSource(sources, entry);
    }
    const summary = publicSummary(await buildAuthorizedSourcesTree(updated));
    await writeNewJson(output, updated);
    console.log(stringifyCrypto({ sourcesFile: output, ...summary }));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

await run(process.argv[2], process.argv.slice(3));
