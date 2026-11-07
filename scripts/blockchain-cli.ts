/** Ejecuta despliegues, administración de raíces, registros ZKP y consultas en una red local o en Polygon Amoy. */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { connectBlockchain, createRegistrationOperation, deployContracts, loadDeployment, measureVerifierGas, queryContent, queryFile, readRegistryConfiguration, registerProof, saveDeployment, checkDeployment, transactionWallet } from "../src/blockchain.ts";
import { parseField, stringifyCrypto } from "../src/encoding.mjs";
import { calculateContentHash } from "../src/hashing.mjs";
import { derivePublicKey } from "../src/eddsa.mjs";
import { generatePrivateKey } from "../src/key-management.mjs";
import { signContentAuthorization } from "../src/authorization.mjs";
import { buildAuthorizedSourcesTree, getSourceProof } from "../src/merkle.mjs";
import { createProofInputs, ensureZkArtifacts, generateProof } from "../src/zkp.mjs";

// La selección de red es explícita; la demostración usa una cadena local aislada por defecto.
const COMMANDS = ["deploy", "root", "disable", "config", "check", "operation", "register", "query", "demo"];
const OPTIONS = {
  network: { type: "string" }, deployment: { type: "string" }, sources: { type: "string" },
  root: { type: "string" }, "source-id": { type: "string" }, registrant: { type: "string" },
  input: { type: "string" }, file: { type: "string" }, hash: { type: "string" }, out: { type: "string" },
  help: { type: "boolean" },
} as const;

/**
 * Exige un argumento del comando antes de enviar transacciones o leer datos de autorización.
 * Entradas. Valor opcional y nombre del argumento de consola.
 * Salida. Valor de texto requerido.
 */
function required(value: string | undefined, name: string): string {
  if (!value) throw new Error("Falta --" + name);
  return value;
}

/**
 * Lee JSON y ofrece un error breve que no revela el contenido del archivo recibido.
 * Entradas. Ruta al archivo JSON.
 * Salida. Promesa del valor JSON analizado.
 */
async function readJson(filename: string) {
  try { return JSON.parse(await readFile(filename, "utf8")); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error("Archivo JSON inválido");
    throw error;
  }
}

/**
 * Muestra un resultado público o crea un archivo nuevo sin sobrescribir otro resultado.
 * Entradas. Dato serializable y ruta opcional.
 * Salida. Promesa sin valor. Imprime el JSON o lo escribe en un archivo nuevo.
 */
async function output(value: unknown, filename?: string) {
  const text = stringifyCrypto(value) + "\n";
  if (!filename) { process.stdout.write(text); return; }
  await mkdir(path.dirname(path.resolve(filename)), { recursive: true });
  await writeFile(filename, text, { flag: "wx", mode: 0o600 });
}

/**
 * Ejecuta desde los bytes del archivo hasta la consulta final, usando una firma y una prueba Groth16 reales.
 * Entradas. Red, ruta del archivo multimedia y destino opcional del informe.
 * Salida. Promesa sin valor. Despliega, registra, consulta y publica un informe.
 */
async function runDemo(networkName: string, filename: string, outputFile?: string) {
  const hashStart = performance.now();
  const contentHash = await calculateContentHash(filename);
  const hashingMs = performance.now() - hashStart;
  const connection = await connectBlockchain(networkName);
  const seed = generatePrivateKey();
  try {
    const publicKey = await derivePublicKey(seed);
    const tree = await buildAuthorizedSourcesTree([{ sourceId: 1n, publicKey }]);
    const deployment = await deployContracts(connection, tree.root);
    const operation = await createRegistrationOperation(connection, deployment.registryAddress, 1n);
    const authorization = await signContentAuthorization({ contentHash, ...operation }, seed);
    const membership = await getSourceProof(tree, 1n);
    const inputs = await createProofInputs(authorization, membership);
    const proof = await generateProof(inputs);
    const measured = await measureVerifierGas(connection, deployment, proof);
    const registration = await registerProof(connection, deployment, proof);
    const query = await queryFile(connection, deployment.registryAddress, filename);
    if (!query.record.exists || query.record.contentHash !== contentHash) throw new Error("El contenido no pudo consultarse después de registrarlo");
    const manifest = await ensureZkArtifacts();
    const result = {
      format: "content-authenticity-experiment-v1", runAt: new Date().toISOString(),
      network: deployment.network, chainId: deployment.chainId, ephemeral: deployment.ephemeral,
      artifactId: proof.artifactId, setup: manifest.setup, contentHash, deployment,
      publicSignals: proof.publicSignals, registration, record: query.record,
      metrics: { ...manifest.metrics, hashingMs, ...proof.metrics,
        verifierGas: measured.verifierGas, verifierGasEstimate: registration.verifierGasEstimate,
        proofAbiBytes: registration.proofAbiBytes, registrationGas: registration.registrationGas,
        confirmationMs: registration.confirmationMs },
    };
    const report = outputFile ?? path.join("metrics", "runs", "demo-" + Date.now() + ".json");
    await output(result, report);
    await output({ success: true, contentHash, registryAddress: deployment.registryAddress,
      transactionHash: registration.transactionHash, report, metrics: result.metrics });
  } finally {
    seed.fill(0);
    await connection.close();
  }
}

/**
 * Interpreta el comando y mantiene los datos privados de operación fuera de las salidas públicas.
 * Entradas. Sin argumentos. Lee el comando y sus opciones de process.argv.
 * Salida. Promesa sin valor. Ejecuta la operación y publica el resultado que corresponda.
 */
async function run() {
  const command = process.argv[2];
  const { values } = parseArgs({ args: process.argv.slice(3), options: OPTIONS, strict: true });
  if (command === "--help" || values.help) {
    console.log("Uso: blockchain-cli <deploy|root|disable|config|check|operation|register|query|demo> [--network localhost|amoy] [--deployment archivo.json] [--sources fuentes.json] [--root decimal] [--source-id decimal] [--registrant direccion] [--input prueba.json] [--file multimedia] [--hash decimal] [--out salida.json]");
    return;
  }
  if (!COMMANDS.includes(command)) throw new Error("Comando blockchain desconocido; utiliza --help");
  if (command !== "deploy" && values.out && existsSync(values.out)) throw new Error("La salida ya existe; utiliza otro nombre de archivo");
  if (command === "demo") {
    await runDemo(values.network ?? "hardhatMainnet", values.file ?? "samples/prueba.txt", values.out);
    return;
  }
  const connection = await connectBlockchain(values.network);
  try {
    const publicClient = await connection.viem.getPublicClient();
    if (command === "deploy") {
      let root: bigint | undefined;
      if (values.sources) root = (await buildAuthorizedSourcesTree(await readJson(values.sources))).root;
      else if (values.root || process.env.AUTHORIZATION_ROOT) root = parseField(values.root || process.env.AUTHORIZATION_ROOT, "authorizedSourcesRoot");
      const deployment = await deployContracts(connection, root);
      const deploymentFile = await saveDeployment(deployment, values.out);
      await output({ deploymentFile, ...deployment });
      return;
    }
    const deployment = await loadDeployment(connection, values.deployment);
    if (command === "config") await output(await readRegistryConfiguration(connection, deployment.registryAddress), values.out);
    else if (command === "check") await output(await checkDeployment(connection, deployment), values.out);
    else if (command === "query") {
      if (Boolean(values.file) === Boolean(values.hash)) throw new Error("Indica exactamente una opción: --file o --hash");
      const result = values.file ? await queryFile(connection, deployment.registryAddress, values.file)
        : { contentHash: parseField(values.hash, "contentHash"), record: await queryContent(connection, deployment.registryAddress, required(values.hash, "hash")) };
      await output(result, values.out);
    } else if (command === "operation") {
      const filename = required(values.out, "out");
      const operation = await createRegistrationOperation(connection, deployment.registryAddress, required(values["source-id"], "source-id"), values.registrant);
      await output(operation, filename);
      await output({ operationFile: filename, context: operation.context });
    } else if (command === "register") {
      await output(await registerProof(connection, deployment, await readJson(required(values.input, "input"))), values.out);
    } else {
      const wallet = await transactionWallet(connection);
      const registry = await connection.viem.getContractAt("ContentRegistry", deployment.registryAddress, { client: { public: publicClient, wallet } });
      let transactionHash;
      if (command === "disable") transactionHash = await registry.write.disableAuthorizedSourcesRoot();
      else {
        const root = values.sources ? (await buildAuthorizedSourcesTree(await readJson(values.sources))).root
          : parseField(required(values.root || process.env.AUTHORIZATION_ROOT, "root o sources"), "authorizedSourcesRoot");
        transactionHash = await registry.write.setAuthorizedSourcesRoot([root]);
      }
      const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
      if (receipt.status !== "success") throw new Error("La administración de la raíz fue rechazada");
      await output({ transactionHash, ...(await readRegistryConfiguration(connection, deployment.registryAddress)) }, values.out);
    }
  } finally { await connection.close(); }
}

try { await run(); }
catch (error) { console.error("Error: " + (error instanceof Error ? error.message : String(error))); process.exitCode = 1; }
