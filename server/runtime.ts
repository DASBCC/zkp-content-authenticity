/** Conserva la configuración privada del servicio y prepara claves y despliegues locales mediante una operación explícita. */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { deployContracts, loadDeployment, saveDeployment, transactionWallet } from "../src/blockchain.ts";
import type { BlockchainConnection } from "../src/blockchain.ts";
import { canonicalAddress, stringifyCrypto } from "../src/encoding.mjs";
import { generatePrivateKey, loadPrivateKey, savePrivateKey } from "../src/key-management.mjs";
import { derivePublicKey } from "../src/eddsa.mjs";
import { buildAuthorizedSourcesTree } from "../src/merkle.mjs";
import type { WebRuntime } from "./app.ts";

/**
 * Persiste configuración operativa fuera de la carpeta pública y sin imprimir claves.
 * Entradas. Configuración operativa con ruta de persistencia opcional.
 * Salida. Promesa sin valor. Guarda la configuración cuando dispone de una ruta.
 */
export async function persistRuntime(runtime: WebRuntime) {
  if (!runtime.runtimeFile) return;
  const temporary = runtime.runtimeFile + ".tmp";
  await writeFile(temporary, stringifyCrypto(runtime) + "\n", { mode: 0o600 });
  await rename(temporary, runtime.runtimeFile);
}

/**
 * Detecta únicamente el nodo de laboratorio de este proyecto, nunca una red externa.
 * Entradas. Conexión Hardhat que se quiere clasificar.
 * Salida. Promesa de true si es HTTP local en la cadena 31337, o false en otro caso.
 */
export async function isLocal(connection: BlockchainConnection) {
  return connection.networkName === "localhost" && connection.networkConfig.type === "http" && ["localhost", "127.0.0.1"].includes(new URL(await connection.networkConfig.url.getUrl()).hostname) && await (await connection.viem.getPublicClient()).getChainId() === 31337;
}

/**
 * Carga la configuración operativa guardada o la especificada en el entorno.
 * Entradas. Conexión Hardhat de la red que se va a servir.
 * Salida. Promesa de la configuración operativa con permisos y despliegue si está disponible.
 */
export async function loadRuntime(connection: BlockchainConnection): Promise<WebRuntime> {
  const privateRoot = path.resolve(process.env.WEB_DATA_DIRECTORY || ".local-web");
  const localFile = connection.networkName === "localhost" ? path.join(privateRoot, "runtime.json") : path.join(privateRoot, "networks", connection.networkName, "runtime.json");
  const configuredNetwork = process.env.BLOCKCHAIN_NETWORK || "localhost";
  const deploymentOverride = connection.networkName === configuredNetwork ? process.env.WEB_DEPLOYMENT_FILE : undefined;
  if (existsSync(localFile) && !deploymentOverride) {
    const runtime = JSON.parse(await readFile(localFile, "utf8")) as WebRuntime;
    runtime.runtimeFile = localFile;
    return runtime;
  }
  const selectedEnvironment = connection.networkName === configuredNetwork ? process.env : {};
  const signingEnabled = selectedEnvironment.WEB_SIGNING_ENABLED === "true";
  const allowedRegistrants = (selectedEnvironment.WEB_ALLOWED_REGISTRANTS ?? "").split(",").filter(Boolean).map(/* Valida cada cuenta admitida expresamente por el operador. Entradas. Texto de una dirección de la lista del entorno. Salida. Dirección EVM recortada y normalizada. */ (address) => canonicalAddress(address.trim(), "cuenta permitida"));
  if (signingEnabled && (!allowedRegistrants.length || !selectedEnvironment.WEB_SOURCE_KEY_FILE || !selectedEnvironment.WEB_SOURCES_FILE || !selectedEnvironment.WEB_SOURCE_ID)) throw new Error("Habilitar la firma requiere clave, conjunto, identificador y cuentas permitidas explícitos.");
  let deployment;
  try { deployment = await loadDeployment(connection, deploymentOverride); }
  catch { if (deploymentOverride) throw new Error("No se pudo cargar el archivo de despliegue configurado."); }
  await mkdir(path.dirname(localFile), { recursive: true });
  return { deployment, runtimeFile: localFile, experimental: false, signingEnabled, allowedRegistrants, sourceId: selectedEnvironment.WEB_SOURCE_ID || "1",
    sourceKeyFile: selectedEnvironment.WEB_SOURCE_KEY_FILE ? path.resolve(selectedEnvironment.WEB_SOURCE_KEY_FILE) : "",
    sourcesFile: selectedEnvironment.WEB_SOURCES_FILE ? path.resolve(selectedEnvironment.WEB_SOURCES_FILE) : "",
    walletRpcUrl: (connection.networkName === configuredNetwork ? process.env.WEB_PUBLIC_RPC_URL : undefined) || (connection.networkName === "amoy" ? "https://polygon-amoy.drpc.org" : "http://127.0.0.1:8545") };
}

/**
 * Prepara una fuente de desarrollo y contratos reales tras la autorización del administrador local.
 * Entradas. Conexión al nodo local y lista de cuentas autorizadas para registrar.
 * Salida. Promesa de la configuración experimental persistida con el despliegue y la fuente.
 */
export async function initializeLocalRuntime(connection: BlockchainConnection, registrants: string[]): Promise<WebRuntime> {
  if (!await isLocal(connection)) throw new Error("La preparación experimental solo se permite en el nodo local 31337.");
  const root = path.resolve(process.env.WEB_DATA_DIRECTORY || ".local-web");
  await mkdir(root, { recursive: true });
  const sourceKeyFile = path.join(root, "source-private.json");
  const sourcesFile = path.join(root, "sources.json");
  let seed: Uint8Array | undefined;
  try {
    if (!existsSync(sourceKeyFile)) { seed = generatePrivateKey(); await savePrivateKey(sourceKeyFile, seed); }
    else seed = await loadPrivateKey({ filePath: sourceKeyFile, env: {} });
    if (!existsSync(sourcesFile)) await writeFile(sourcesFile, stringifyCrypto([{ sourceId: 1n, publicKey: await derivePublicKey(seed) }]) + "\n", { flag: "wx", mode: 0o600 });
    const tree = await buildAuthorizedSourcesTree(JSON.parse(await readFile(sourcesFile, "utf8")));
    const deployment = await deployContracts(connection, tree.root);
    await saveDeployment(deployment, process.env.WEB_DATA_DIRECTORY ? path.join(root, "deployment.json") : undefined);
    const runtime: WebRuntime = { deployment, experimental: true, signingEnabled: true, sourceId: "1", sourceKeyFile, sourcesFile,
      sourceKeys: { "1": sourceKeyFile }, runtimeFile: path.join(root, "runtime.json"),
      allowedRegistrants: [...new Set([deployment.owner.toLowerCase(), ...registrants.map(/* Normaliza cuentas aprobadas durante la preparación. Entradas. Dirección aprobada durante la preparación. Salida. Dirección EVM canónica. */ (address) => canonicalAddress(address, "registrante"))])], walletRpcUrl: "http://127.0.0.1:8545" };
    await persistRuntime(runtime);
    return runtime;
  } finally { seed?.fill(0); }
}

/**
 * Obtiene la cuenta administradora inicial sin habilitar nuevas credenciales en el navegador.
 * Entradas. Conexión Hardhat utilizada durante la preparación.
 * Salida. Promesa de la dirección administradora configurada o la primera wallet de la conexión.
 */
export async function bootstrapOwner(connection: BlockchainConnection) {
  return process.env.WEB_BOOTSTRAP_ADMIN ? canonicalAddress(process.env.WEB_BOOTSTRAP_ADMIN, "administrador inicial") : (await transactionWallet(connection)).account.address;
}
