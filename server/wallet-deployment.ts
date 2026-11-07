/** Prepara despliegues firmados por una wallet y adopta únicamente recibos y bytecodes comprobados en la red real. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { artifacts } from "hardhat";
import { encodeDeployData, encodeFunctionData, keccak256 } from "viem";
import type { Address, Hash, Hex } from "viem";
import type { BlockchainConnection, DeploymentRecord } from "../src/blockchain.ts";
import { checkDeployment, registryReader, saveDeployment } from "../src/blockchain.ts";
import { canonicalAddress, stringifyCrypto } from "../src/encoding.mjs";
import { generatePrivateKey, savePrivateKey } from "../src/key-management.mjs";
import { derivePublicKey } from "../src/eddsa.mjs";
import { buildAuthorizedSourcesTree } from "../src/merkle.mjs";
import { ensureZkArtifacts } from "../src/zkp.mjs";
import { PROTOCOL_DOMAIN, PROTOCOL_VERSION } from "../src/protocol.mjs";
import { ServiceError, capability } from "./security.ts";
import { persistRuntime } from "./runtime.ts";
import type { WebRuntime } from "./app.ts";

interface DeploymentPlan {
  id: string; token: string; owner: Address; chainId: string; artifactId: string; root: string;
  sourceKeyFile: string; sourcesFile: string; verifierTransaction?: Hash; registryTransaction?: Hash;
}

/**
 * Conserva los planes privados por red y evita usar claves EVM del servidor para los despliegues de la web.
 * Entradas. Conexión a la red y configuración operativa del servicio.
 * Salida. Controlador para preparar planes, validar avances, adoptar despliegues y autorizar transacciones.
 */
export function walletDeployments(connection: BlockchainConnection, runtime: WebRuntime) {
  const directory = path.resolve(runtime.runtimeFile ? path.dirname(runtime.runtimeFile) : path.join(process.env.WEB_DATA_DIRECTORY || ".local-web", connection.networkName), "deployment-plans");

  /**
   * Exige un identificador aleatorio canónico antes de resolver su archivo privado.
   * Entradas. Identificador del plan de despliegue.
   * Salida. Ruta al JSON privado del plan.
   */
  function filename(id: string) {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) throw new ServiceError("BAD_REQUEST", "El plan de despliegue no es válido.");
    return path.join(directory, id + ".json");
  }

  /**
   * Recupera un plan privado y comprueba la capacidad de acceso entregada al navegador.
   * Entradas. Identificador del plan y token de capacidad.
   * Salida. Promesa del plan privado vigente para la cadena y los artefactos actuales.
   */
  async function load(id: string, token: string) {
    let plan: DeploymentPlan;
    try { plan = JSON.parse(await readFile(filename(id), "utf8")); }
    catch { throw new ServiceError("DEPLOYMENT_PLAN_MISSING", "No se encontró el plan de despliegue. Prepara uno nuevo.", 404); }
    if (plan.token !== token) throw new ServiceError("DEPLOYMENT_PLAN_MISSING", "No tienes acceso al plan de despliegue.", 404);
    const client = await connection.viem.getPublicClient();
    if (plan.chainId !== String(await client.getChainId()) || plan.artifactId !== (await ensureZkArtifacts()).artifactId) throw new ServiceError("DEPLOYMENT_PLAN_CHANGED", "La red o los artefactos cambiaron desde que se preparó este despliegue.", 409);
    return plan;
  }

  /**
   * Prepara una fuente de desarrollo y los datos necesarios para desplegar con la wallet.
   * Entradas. Dirección de la cuenta que firmará el despliegue.
   * Salida. Promesa del plan con identificador, token, red, raíz, ABI y bytecode.
   */
  async function prepare(address: Address) {
    const manifest = await ensureZkArtifacts();
    const id = randomUUID();
    await mkdir(directory, { recursive: true });
    const sourceKeyFile = path.join(directory, id + "-source-private.json");
    const sourcesFile = path.join(directory, id + "-sources.json");
    const seed = generatePrivateKey();
    let tree;
    try {
      await savePrivateKey(sourceKeyFile, seed);
      tree = await buildAuthorizedSourcesTree([{ sourceId: "1", publicKey: await derivePublicKey(seed) }]);
      await writeFile(sourcesFile, stringifyCrypto(tree.sources) + "\n", { flag: "wx", mode: 0o600 });
    } finally { seed.fill(0); }
    const plan: DeploymentPlan = { id, token: capability(), owner: address, chainId: String(await (await connection.viem.getPublicClient()).getChainId()), artifactId: manifest.artifactId, root: tree.root.toString(), sourceKeyFile, sourcesFile };
    await writeFile(filename(id), stringifyCrypto(plan), { flag: "wx", mode: 0o600 });
    const verifier = await artifacts.readArtifact("Groth16Verifier");
    const registry = await artifacts.readArtifact("ContentRegistry");
    return { planId: id, planToken: plan.token, owner: address, chainId: plan.chainId, artifactId: plan.artifactId, root: plan.root,
      verifier: { abi: verifier.abi, bytecode: verifier.bytecode }, registry: { abi: registry.abi, bytecode: registry.bytecode } };
  }

  /**
   * Verifica creador, recibo y datos exactos de creación antes de aceptar una dirección de contrato.
   * Entradas. Hash de la transacción, dirección del creador y datos de creación esperados.
   * Salida. Promesa de la dirección confirmada del contrato.
   */
  async function creation(hash: Hash, owner: Address, expectedInput: Hex) {
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new ServiceError("BAD_REQUEST", "La referencia de transacción no es válida.");
    const client = await connection.viem.getPublicClient();
    const [transaction, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
    if (transaction.from.toLowerCase() !== owner.toLowerCase() || transaction.to !== null || transaction.value !== 0n || transaction.input.toLowerCase() !== expectedInput.toLowerCase() || receipt.status !== "success" || !receipt.contractAddress) throw new ServiceError("DEPLOYMENT_MISMATCH", "La transacción no creó el contrato esperado desde la cuenta autorizada.", 409);
    return receipt.contractAddress;
  }

  /**
   * Comprueba y conserva avances confirmados para poder continuar después de rechazar una transacción.
   * Entradas. Identificador y token del plan, etapa y hash de la transacción.
   * Salida. Promesa de un objeto con saved en true tras persistir el avance.
   */
  async function progress(id: string, token: string, kind: string, hash: Hash) {
    const plan = await load(id, token);
    const verifierArtifact = await artifacts.readArtifact("Groth16Verifier");
    if (kind === "verifier") { await creation(hash, plan.owner, encodeDeployData({ abi: verifierArtifact.abi, bytecode: verifierArtifact.bytecode })); plan.verifierTransaction = hash; }
    else if (kind === "registry" && plan.verifierTransaction) {
      const verifier = await creation(plan.verifierTransaction, plan.owner, encodeDeployData({ abi: verifierArtifact.abi, bytecode: verifierArtifact.bytecode }));
      const registry = await artifacts.readArtifact("ContentRegistry");
      await creation(hash, plan.owner, encodeDeployData({ abi: registry.abi, bytecode: registry.bytecode, args: [verifier] }));
      plan.registryTransaction = hash;
    } else throw new ServiceError("BAD_REQUEST", "El avance de despliegue no corresponde a la etapa esperada.");
    await writeFile(filename(id), stringifyCrypto(plan), { mode: 0o600 });
    return { saved: true };
  }

  /**
   * Adopta el despliegue únicamente tras comprobar ambos contratos, propietario, dominio y raíz publicada.
   * Entradas. Cuenta autorizada y plan con hashes de despliegue y publicación de raíz.
   * Salida. Promesa de un objeto con ready en true y los metadatos públicos del despliegue adoptado.
   */
  async function commit(address: Address, input: { planId: string; planToken: string; verifierTransaction: Hash; registryTransaction: Hash; rootTransaction: Hash }) {
    const plan = await load(input.planId, input.planToken);
    if (plan.owner.toLowerCase() !== address.toLowerCase()) throw new ServiceError("ADMIN_ONLY", "El plan pertenece a otra cuenta.", 403);
    const verifierArtifact = await artifacts.readArtifact("Groth16Verifier");
    const registryArtifact = await artifacts.readArtifact("ContentRegistry");
    const verifierAddress = await creation(input.verifierTransaction, address, encodeDeployData({ abi: verifierArtifact.abi, bytecode: verifierArtifact.bytecode }));
    const registryAddress = await creation(input.registryTransaction, address, encodeDeployData({ abi: registryArtifact.abi, bytecode: registryArtifact.bytecode, args: [verifierAddress] }));
    const registry = await registryReader(connection, registryAddress);
    if ((await registry.read.verifier()).toLowerCase() !== verifierAddress.toLowerCase() || (await registry.read.owner()).toLowerCase() !== address.toLowerCase() || !await registry.read.rootEnabled() || (await registry.read.authorizedSourcesRoot()).toString() !== plan.root || await registry.read.PROTOCOL_VERSION() !== PROTOCOL_VERSION || await registry.read.PROTOCOL_DOMAIN() !== PROTOCOL_DOMAIN) throw new ServiceError("DEPLOYMENT_MISMATCH", "Los contratos no tienen la configuración autorizada.", 409);
    const client = await connection.viem.getPublicClient();
    const rootTx = await client.getTransaction({ hash: input.rootTransaction });
    const rootReceipt = await client.getTransactionReceipt({ hash: input.rootTransaction });
    if (rootTx.from.toLowerCase() !== address.toLowerCase() || rootTx.to?.toLowerCase() !== registryAddress.toLowerCase() || rootTx.input.toLowerCase() !== encodeFunctionData({ abi: registryArtifact.abi, functionName: "setAuthorizedSourcesRoot", args: [BigInt(plan.root)] }).toLowerCase() || rootReceipt.status !== "success") throw new ServiceError("DEPLOYMENT_MISMATCH", "La publicación de raíz no fue confirmada desde la cuenta autorizada.", 409);
    const verifierCode = await client.getCode({ address: verifierAddress });
    const registryCode = await client.getCode({ address: registryAddress });
    if (!verifierCode || !registryCode) throw new ServiceError("DEPLOYMENT_MISMATCH", "No se encontró el código de los contratos.", 409);
    const record: DeploymentRecord = { format: "content-authenticity-deployment-v1", network: connection.networkName, chainId: plan.chainId,
      verifierAddress, registryAddress, owner: address, artifactId: plan.artifactId, ephemeral: connection.networkName === "localhost" || connection.networkConfig.type === "edr-simulated",
      createdAt: new Date().toISOString(), transactions: { verifier: input.verifierTransaction, registry: input.registryTransaction, root: input.rootTransaction }, codeHashes: { verifier: keccak256(verifierCode), registry: keccak256(registryCode) } };
    await checkDeployment(connection, record);
    const privateRoot = path.dirname(directory);
    runtime.deployment = record; runtime.experimental = true; runtime.signingEnabled = true;
    runtime.allowedRegistrants = [canonicalAddress(address, "registrante")]; runtime.sourceId = "1";
    runtime.sourceKeyFile = plan.sourceKeyFile; runtime.sourcesFile = plan.sourcesFile; runtime.sourceKeys = { "1": plan.sourceKeyFile };
    runtime.runtimeFile ??= path.join(privateRoot, connection.networkName + "-runtime.json");
    await persistRuntime(runtime);
    await saveDeployment(record, process.env.WEB_DATA_DIRECTORY || connection.networkConfig.type === "edr-simulated" ? path.join(privateRoot, connection.networkName + "-deployment.json") : undefined);
    return { ready: true, ...record };
  }

  /**
   * Restringe la wallet de laboratorio a creaciones exactas y raíces de planes autorizados para esa cuenta.
   * Entradas. Cuenta, destino opcional y calldata de la transacción propuesta.
   * Salida. Promesa de true si la operación coincide con un plan de la cuenta, o false si no coincide.
   */
  async function allowsTransaction(address: Address, to: Address | undefined, data: Hex) {
    let files;
    try { files = await readdir(directory); } catch { return false; }
    const verifier = await artifacts.readArtifact("Groth16Verifier");
    const registry = await artifacts.readArtifact("ContentRegistry");
    for (const file of files) {
      if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
      const plan: DeploymentPlan = JSON.parse(await readFile(path.join(directory, file), "utf8"));
      if (plan.owner.toLowerCase() !== address.toLowerCase()) continue;
      if (!to && data.toLowerCase() === encodeDeployData({ abi: verifier.abi, bytecode: verifier.bytecode }).toLowerCase()) return true;
      if (!plan.verifierTransaction) continue;
      const verifierAddress = await creation(plan.verifierTransaction, address, encodeDeployData({ abi: verifier.abi, bytecode: verifier.bytecode }));
      const registryInput = encodeDeployData({ abi: registry.abi, bytecode: registry.bytecode, args: [verifierAddress] });
      if (!to && data.toLowerCase() === registryInput.toLowerCase()) return true;
      if (to && plan.registryTransaction) {
        const registryAddress = await creation(plan.registryTransaction, address, registryInput);
        if (registryAddress.toLowerCase() === to.toLowerCase() && data.toLowerCase() === encodeFunctionData({ abi: registry.abi, functionName: "setAuthorizedSourcesRoot", args: [BigInt(plan.root)] }).toLowerCase()) return true;
      }
    }
    return false;
  }

  return { prepare, progress, commit, allowsTransaction };
}
