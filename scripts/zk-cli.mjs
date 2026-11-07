/** Ejecuta la compilación, el setup local y la generación o verificación de pruebas Groth16. */

import { parseArgs } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { calculateWitness, compileCircuit, createProofInputs, ensureZkArtifacts, generateProof, setupGroth16, verifyProof } from "../src/zkp.mjs";
import { deserializeAuthorizationPackage } from "../src/authorization.mjs";
import { stringifyCrypto } from "../src/encoding.mjs";

// Opciones comunes de los comandos del circuito y sus pruebas.
const OPTIONS = { artifacts: { type: "string" }, input: { type: "string" }, authorization: { type: "string" }, membership: { type: "string" }, out: { type: "string" }, force: { type: "boolean" }, resume: { type: "boolean" }, help: { type: "boolean" } };
const COMMANDS = ["compile", "setup", "inputs", "witness", "prove", "verify", "export-verifier"];

/**
 * Exige una ruta de entrada antes de leer datos privados o pruebas serializadas.
 * Entradas. Opciones analizadas y nombre del argumento requerido.
 * Salida. Valor de la opción requerida.
 */
function required(values, name) {
  if (!values[name]) throw new Error(`Falta --${name}`);
  return values[name];
}

/**
 * Lee JSON sin incorporar su contenido a los errores de sintaxis.
 * Entradas. Ruta a un archivo JSON de artefactos, entradas o prueba.
 * Salida. Promesa del valor JSON analizado.
 */
async function readJson(filename) {
  try { return JSON.parse(await readFile(filename, "utf8")); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error("Archivo JSON inválido");
    throw error;
  }
}

/**
 * Guarda una salida nueva sin sobrescribir resultados de ejecuciones anteriores.
 * Entradas. Dato serializable y ruta de destino opcional.
 * Salida. Promesa sin valor. Imprime el JSON o crea un archivo nuevo.
 */
async function output(value, filename) {
  const text = stringifyCrypto(value) + "\n";
  if (!filename) { process.stdout.write(text); return; }
  await mkdir(path.dirname(path.resolve(filename)), { recursive: true });
  await writeFile(filename, text, { flag: "wx", mode: 0o600 });
}

/**
 * Interpreta el comando y conserva separados los resultados públicos y las entradas privadas.
 * Entradas. Sin argumentos. Lee el subcomando y sus opciones de process.argv.
 * Salida. Promesa sin valor. Ejecuta el comando Groth16 y publica su resultado.
 */
async function run() {
  const command = process.argv[2];
  const { values } = parseArgs({ args: process.argv.slice(3), options: OPTIONS, strict: true });
  if (command === "--help" || values.help) {
    console.log("Uso: node scripts/zk-cli.mjs <compile|setup|inputs|witness|prove|verify|export-verifier> [--artifacts ruta] [--input archivo.json] [--authorization paquete.json] [--membership ruta.json] [--out salida] [--force|--resume]");
    return;
  }
  if (!COMMANDS.includes(command)) throw new Error("Comando ZKP desconocido; utiliza --help");
  const options = { artifactsDir: values.artifacts };
  if (command === "compile") await output(await compileCircuit(options), values.out);
  else if (command === "setup") {
    const manifest = await setupGroth16({ ...options, force: values.force, resume: values.resume, onProgress: /* Informa del progreso de la preparación. Entradas. Mensaje público sobre el avance del setup. Salida. Sin valor de retorno. Escribe el mensaje en stderr. */ (message) => console.error(message) });
    await output({ artifactId: manifest.artifactId, setup: manifest.setup, metrics: manifest.metrics }, values.out);
  } else if (command === "inputs") {
    const filename = required(values, "out");
    const authorization = await deserializeAuthorizationPackage(await readFile(required(values, "authorization"), "utf8"));
    const membership = await readJson(required(values, "membership"));
    await output(await createProofInputs(authorization, membership), filename);
    await output({ inputsFile: filename });
  } else if (command === "witness") {
    const result = await calculateWitness(await readJson(required(values, "input")), { ...options, witnessPath: values.out });
    await output(result);
  } else if (command === "prove") await output(await generateProof(await readJson(required(values, "input")), options), values.out);
  else if (command === "verify") {
    const value = await readJson(required(values, "input"));
    const manifest = await ensureZkArtifacts(options);
    if (value.artifactId && value.artifactId !== manifest.artifactId) throw new Error("La prueba corresponde a otros artefactos");
    const valid = await verifyProof(value.proof, value.publicSignals, options);
    await output({ valid }, values.out);
    if (!valid) process.exitCode = 2;
  } else {
    const manifest = await ensureZkArtifacts(options);
    await output({ verifier: manifest.files.verifier.path, sha256: manifest.files.verifier.sha256, artifactId: manifest.artifactId }, values.out);
  }
}

try { await run(); }
catch (error) { console.error(`Error: ${error.message}`); process.exitCode = 1; }
