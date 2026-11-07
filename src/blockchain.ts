/** Integra los contratos reales con Hardhat y viem, conserva los despliegues por red y consulta contenidos sin generar otra prueba. */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { artifacts, network } from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";
import { encodeAbiParameters, encodeFunctionData, getContract, keccak256 } from "viem";
import type { Address, Hash } from "viem";
import { canonicalAddress, parseField, stringifyCrypto } from "./encoding.mjs";
import { calculateContentHash } from "./hashing.mjs";
import { generateNonce, PROTOCOL_DOMAIN, PROTOCOL_VERSION } from "./protocol.mjs";
import { ensureZkArtifacts, formatSolidityProof, verifyProof } from "./zkp.mjs";

export type BlockchainConnection = NetworkConnection<"l1">;
export type Pair = readonly [bigint, bigint];
export type PublicSignals = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
export type ProofArguments = readonly [Pair, readonly [Pair, Pair], Pair, PublicSignals];

export interface DeploymentRecord {
  format: "content-authenticity-deployment-v1";
  network: string;
  chainId: string;
  verifierAddress: Address;
  registryAddress: Address;
  owner: Address;
  artifactId: string;
  ephemeral: boolean;
  createdAt: string;
  transactions: { verifier: Hash; registry: Hash; root?: Hash };
  codeHashes: { verifier: Hash; registry: Hash };
}

/**
 * Abre la red elegida y comprueba que su identificador coincide con el proveedor real.
 * Entradas. Nombre de red opcional, con BLOCKCHAIN_NETWORK o localhost como alternativa.
 * Salida. Promesa de una conexión Hardhat de capa 1 con cadena comprobada.
 */
export async function connectBlockchain(name = process.env.BLOCKCHAIN_NETWORK || "localhost") {
  const connection = await network.create({ network: name, chainType: "l1" });
  try {
    const client = await connection.viem.getPublicClient();
    const chainId = await client.getChainId();
    const expected = connection.networkConfig.chainId;
    if (expected !== undefined && chainId !== expected) throw new Error("El RPC corresponde a una cadena distinta de la configurada");
    return connection;
  } catch (error) {
    await connection.close();
    throw error;
  }
}

/**
 * Selecciona la wallet que firma transacciones en la red activa.
 * Entradas. Conexión Hardhat activa.
 * Salida. Promesa del primer cliente de wallet EVM disponible.
 */
export async function transactionWallet(connection: BlockchainConnection) {
  const [wallet] = await connection.viem.getWalletClients();
  if (!wallet) throw new Error("Falta una cuenta EVM: configura DEPLOYER_PRIVATE_KEY o utiliza las cuentas del nodo local");
  return wallet;
}

/**
 * Construye una instancia de consulta pública que funciona aunque no exista una cuenta de transacciones.
 * Entradas. Conexión y dirección EVM del registro.
 * Salida. Promesa de una instancia de viem con la ABI del registro y un cliente público.
 */
export async function registryReader(connection: BlockchainConnection, registryAddress: string) {
  const publicClient = await connection.viem.getPublicClient();
  const artifact = await artifacts.readArtifact("ContentRegistry");
  return getContract({ address: canonicalAddress(registryAddress, "registryAddress") as Address, abi: artifact.abi, client: publicClient });
}

/**
 * Determina el archivo del último despliegue realmente ejecutado para esta red y cadena.
 * Entradas. Conexión a la red cuyo despliegue se busca.
 * Salida. Promesa de la ruta absoluta del JSON de despliegue.
 */
export async function deploymentFilename(connection: BlockchainConnection) {
  const publicClient = await connection.viem.getPublicClient();
  return path.resolve("deployments", String(await publicClient.getChainId()), connection.networkName + ".json");
}

/**
 * Guarda el despliegue público actual y una copia histórica, sin incluir claves ni datos privados de la fuente.
 * Entradas. Metadatos públicos del despliegue y ruta de destino opcional.
 * Salida. Promesa de la ruta absoluta guardada. También escribe una copia histórica.
 */
export async function saveDeployment(record: DeploymentRecord, filename?: string) {
  const destination = path.resolve(filename ?? path.join("deployments", record.chainId, record.network + ".json"));
  await mkdir(path.dirname(destination), { recursive: true });
  const history = path.join(path.dirname(destination), "history", record.network + "-" + randomUUID() + ".json");
  await mkdir(path.dirname(history), { recursive: true });
  const text = stringifyCrypto(record) + "\n";
  await writeFile(history, text, { flag: "wx" });
  const temporary = destination + "." + randomUUID() + ".tmp";
  await writeFile(temporary, text, { flag: "wx" });
  await rename(temporary, destination);
  return destination;
}

/**
 * Carga un despliegue real por red y contrasta las direcciones opcionales de las variables de entorno.
 * Entradas. Conexión a la cadena y ruta del JSON opcional.
 * Salida. Promesa de un DeploymentRecord validado para la cadena actual.
 */
export async function loadDeployment(connection: BlockchainConnection, filename?: string): Promise<DeploymentRecord> {
  const location = filename ?? await deploymentFilename(connection);
  let record: DeploymentRecord;
  try { record = JSON.parse(await readFile(location, "utf8")); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error("El archivo de despliegue no es JSON válido");
    throw new Error("No existe un despliegue guardado para esta red; ejecuta chain:deploy o usa --deployment");
  }
  if (record.format !== "content-authenticity-deployment-v1") throw new Error("Formato de despliegue incompatible");
  const publicClient = await connection.viem.getPublicClient();
  if (record.chainId !== String(await publicClient.getChainId())) throw new Error("El despliegue guardado corresponde a otra cadena");
  canonicalAddress(record.registryAddress, "registryAddress");
  canonicalAddress(record.verifierAddress, "verifierAddress");
  for (const [name, address] of [["REGISTRY_ADDRESS", record.registryAddress], ["VERIFIER_ADDRESS", record.verifierAddress]]) {
    const configured = process.env[name]?.trim();
    if (configured && canonicalAddress(configured, name) !== address.toLowerCase()) throw new Error(name + " no coincide con el despliegue guardado de esta red");
  }
  return record;
}

/**
 * Despliega el verificador generado y el registro, esperando las transacciones antes de devolver direcciones reales.
 * Entradas. Conexión con wallet y raíz autorizada opcional.
 * Salida. Promesa del DeploymentRecord con direcciones, transacciones y huellas del bytecode.
 */
export async function deployContracts(connection: BlockchainConnection, authorizedRoot?: bigint): Promise<DeploymentRecord> {
  const root = authorizedRoot === undefined ? undefined : parseField(authorizedRoot, "authorizedSourcesRoot");
  if (root === 0n) throw new Error("La raíz autorizada no puede ser cero");
  const manifest = await ensureZkArtifacts();
  const publicClient = await connection.viem.getPublicClient();
  const wallet = await transactionWallet(connection);
  const verifierDeployment = await connection.viem.sendDeploymentTransaction("Groth16Verifier", [], { client: { public: publicClient, wallet } });
  const verifierReceipt = await publicClient.waitForTransactionReceipt({ hash: verifierDeployment.deploymentTransaction.hash });
  if (verifierReceipt.status !== "success") throw new Error("Falló el despliegue del verificador");
  const registryDeployment = await connection.viem.sendDeploymentTransaction("ContentRegistry", [verifierDeployment.contract.address], { client: { public: publicClient, wallet } });
  const registryReceipt = await publicClient.waitForTransactionReceipt({ hash: registryDeployment.deploymentTransaction.hash });
  if (registryReceipt.status !== "success") throw new Error("Falló el despliegue del registro");
  let rootTransaction: Hash | undefined;
  if (root !== undefined) {
    rootTransaction = await registryDeployment.contract.write.setAuthorizedSourcesRoot([root]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: rootTransaction });
    if (receipt.status !== "success") throw new Error("Falló la configuración de la raíz");
  }
  const verifierCode = await publicClient.getCode({ address: verifierDeployment.contract.address });
  const registryCode = await publicClient.getCode({ address: registryDeployment.contract.address });
  if (!verifierCode || !registryCode) throw new Error("No se encontró el código de los contratos desplegados");
  return {
    format: "content-authenticity-deployment-v1", network: connection.networkName,
    chainId: String(await publicClient.getChainId()), verifierAddress: verifierDeployment.contract.address,
    registryAddress: registryDeployment.contract.address, owner: wallet.account.address,
    artifactId: manifest.artifactId, ephemeral: connection.networkConfig.type === "edr-simulated" || connection.networkName === "localhost",
    createdAt: new Date().toISOString(),
    transactions: { verifier: verifierDeployment.deploymentTransaction.hash, registry: registryDeployment.deploymentTransaction.hash, ...(rootTransaction ? { root: rootTransaction } : {}) },
    codeHashes: { verifier: keccak256(verifierCode), registry: keccak256(registryCode) },
  };
}

/**
 * Consulta la configuración del contrato y obtiene el contexto efectivo que debe autorizar la fuente.
 * Entradas. Conexión y dirección del registro desplegado.
 * Salida. Promesa de la configuración con verificador, propietarios, raíz, cadena, versión y dominio.
 */
export async function readRegistryConfiguration(connection: BlockchainConnection, registryAddress: string) {
  const registry = await registryReader(connection, registryAddress);
  const publicClient = await connection.viem.getPublicClient();
  return {
    registryAddress: registry.address, chainId: BigInt(await publicClient.getChainId()),
    verifierAddress: await registry.read.verifier(), owner: await registry.read.owner(),
    pendingOwner: await registry.read.pendingOwner(), root: await registry.read.authorizedSourcesRoot(),
    rootEnabled: await registry.read.rootEnabled(), protocolVersion: await registry.read.PROTOCOL_VERSION(),
    protocolDomain: await registry.read.PROTOCOL_DOMAIN(),
  };
}

/**
 * Contrasta el código del verificador, la identidad del registro y los artefactos asociados al despliegue.
 * Entradas. Conexión y metadatos del despliegue guardado.
 * Salida. Promesa de la configuración validada con valid en true e identificador de artefactos.
 */
export async function checkDeployment(connection: BlockchainConnection, record: DeploymentRecord) {
  const manifest = await ensureZkArtifacts();
  if (record.artifactId !== manifest.artifactId) throw new Error("El despliegue y los artefactos Groth16 no corresponden");
  const publicClient = await connection.viem.getPublicClient();
  if (record.chainId !== String(await publicClient.getChainId())) throw new Error("El despliegue pertenece a otra cadena");
  const verifierCode = await publicClient.getCode({ address: record.verifierAddress });
  const registryCode = await publicClient.getCode({ address: record.registryAddress });
  if (!verifierCode || !registryCode) throw new Error("El nodo no conserva este despliegue; puede haber sido reiniciado");
  const expectedVerifier = await artifacts.readArtifact("Groth16Verifier");
  if (verifierCode.toLowerCase() !== expectedVerifier.deployedBytecode.toLowerCase()) throw new Error("El código del verificador desplegado no coincide con el generado");
  if (keccak256(verifierCode) !== record.codeHashes.verifier || keccak256(registryCode) !== record.codeHashes.registry) throw new Error("El código desplegado cambió respecto al registro guardado");
  const configuration = await readRegistryConfiguration(connection, record.registryAddress);
  if (configuration.verifierAddress.toLowerCase() !== record.verifierAddress.toLowerCase() ||
      configuration.protocolVersion !== PROTOCOL_VERSION || configuration.protocolDomain !== PROTOCOL_DOMAIN) throw new Error("La configuración del registro no corresponde al protocolo");
  return { valid: true, artifactId: manifest.artifactId, ...configuration };
}

/**
 * Crea una operación con datos leídos de la cadena y un número de un solo uso aleatorio de 248 bits.
 * Entradas. Conexión, registro, fuente, registrante opcional y nonce opcional.
 * Salida. Promesa de una operación con versión, fuente, nonce y contexto de registro.
 */
export async function createRegistrationOperation(connection: BlockchainConnection, registryAddress: string, sourceId: string | bigint, registrant?: string, nonce = generateNonce()) {
  const configuration = await readRegistryConfiguration(connection, registryAddress);
  const source = parseField(sourceId, "sourceId");
  if (source === 0n) throw new Error("sourceId debe ser positivo");
  const address = registrant ?? (await transactionWallet(connection)).account.address;
  return {
    protocolVersion: configuration.protocolVersion, sourceId: source, nonce,
    context: { registrant: canonicalAddress(address, "registrant"), chainId: configuration.chainId,
      registryAddress: configuration.registryAddress.toLowerCase(), protocolDomain: configuration.protocolDomain },
  };
}

/**
 * Convierte una prueba JSON a las cuatro tuplas tipadas de la interfaz Solidity.
 * Entradas. Prueba Groth16 y ocho señales públicas.
 * Salida. Promesa de la tupla [pA, pB, pC, publicSignals] con valores BigInt.
 */
export async function proofArguments(proof: unknown, publicSignals: unknown): Promise<ProofArguments> {
  const value = await formatSolidityProof(proof, publicSignals);
  return [value.pA as Pair, value.pB as readonly [Pair, Pair], value.pC as Pair, value.publicSignals as PublicSignals];
}

/**
 * Registra una prueba real y devuelve el gas y el tiempo de confirmación sin exponer el testigo.
 * Entradas. Conexión, despliegue y paquete con prueba, señales e identificador de artefactos opcional.
 * Salida. Promesa de un resumen con transacción, huella, bloque, tamaño de la prueba, gas y latencia.
 */
export async function registerProof(connection: BlockchainConnection, record: DeploymentRecord, bundle: { proof: unknown; publicSignals: unknown; artifactId?: string }) {
  await checkDeployment(connection, record);
  if (bundle.artifactId && bundle.artifactId !== record.artifactId) throw new Error("La prueba corresponde a otro conjunto de artefactos");
  if (!await verifyProof(bundle.proof, bundle.publicSignals)) throw new Error("La prueba Groth16 no es válida");
  const publicClient = await connection.viem.getPublicClient();
  const wallet = await transactionWallet(connection);
  const registry = await connection.viem.getContractAt("ContentRegistry", record.registryAddress, { client: { public: publicClient, wallet } });
  const verifier = await connection.viem.getContractAt("Groth16Verifier", record.verifierAddress, { client: { public: publicClient, wallet } });
  const args = await proofArguments(bundle.proof, bundle.publicSignals);
  const verifierData = encodeFunctionData({ abi: verifier.abi, functionName: "verifyProof", args });
  const verifierGasEstimate = await publicClient.estimateGas({ account: wallet.account, to: verifier.address, data: verifierData });
  const proofAbiBytes = (encodeAbiParameters([{ type: "uint256[2]" }, { type: "uint256[2][2]" }, { type: "uint256[2]" }], [args[0], args[1], args[2]]).length - 2) / 2;
  const start = performance.now();
  const hash = await registry.write.register(args);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("El registro fue rechazado por la cadena");
  return { transactionHash: hash, contentHash: args[3][0], blockNumber: receipt.blockNumber,
    verifierGasEstimate, proofAbiBytes, registrationGas: receipt.gasUsed, confirmationMs: performance.now() - start };
}

/**
 * Ejecuta una transacción de ensayo sobre el verificador para medir su gas real por separado del registro.
 * Entradas. Conexión, despliegue y paquete con prueba Groth16 y señales públicas.
 * Salida. Promesa del gas consumido por el verificador y la huella de su transacción.
 */
export async function measureVerifierGas(connection: BlockchainConnection, record: DeploymentRecord, bundle: { proof: unknown; publicSignals: unknown }) {
  const publicClient = await connection.viem.getPublicClient();
  const wallet = await transactionWallet(connection);
  const verifier = await connection.viem.getContractAt("Groth16Verifier", record.verifierAddress, { client: { public: publicClient, wallet } });
  const args = await proofArguments(bundle.proof, bundle.publicSignals);
  if (!await verifier.read.verifyProof(args)) throw new Error("El verificador desplegado rechazó la prueba de medición");
  const data = encodeFunctionData({ abi: verifier.abi, functionName: "verifyProof", args });
  const hash = await wallet.sendTransaction({ to: verifier.address, data });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Falló la transacción de medición del verificador");
  return { verifierGas: receipt.gasUsed, transactionHash: hash };
}

/**
 * Consulta un contenido por su huella pública sin utilizar claves de fuente, testigos ni otra prueba ZKP.
 * Entradas. Conexión, dirección del registro y huella BigInt o decimal.
 * Salida. Promesa del registro público. Su campo exists indica si se encontró.
 */
export async function queryContent(connection: BlockchainConnection, registryAddress: string, contentHash: bigint | string) {
  const registry = await registryReader(connection, registryAddress);
  return registry.read.getRecord([parseField(contentHash, "contentHash")]);
}

/**
 * Recalcula la huella de un archivo multimedia y consulta si consta en el registro elegido.
 * Entradas. Conexión, dirección del registro y ruta del archivo local.
 * Salida. Promesa de un objeto con la huella calculada y el registro público.
 */
export async function queryFile(connection: BlockchainConnection, registryAddress: string, filename: string) {
  const contentHash = await calculateContentHash(filename);
  return { contentHash, record: await queryContent(connection, registryAddress, contentHash) };
}
