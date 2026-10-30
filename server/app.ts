/** Expone configuración pública, RPC de lectura y autorización/prover privados con controles de origen y permisos. */

import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fork } from "node:child_process";
import { artifacts } from "hardhat";
import { decodeFunctionData, hexToString } from "viem";
import type { Address, Hex } from "viem";
import type { BlockchainConnection, DeploymentRecord } from "../src/blockchain.ts";
import { checkDeployment, queryContent, readRegistryConfiguration } from "../src/blockchain.ts";
import { canonicalAddress, exactKeys, parseField, stringifyCrypto } from "../src/encoding.mjs";
import { buildAuthorizedSourcesTree } from "../src/merkle.mjs";
import { ChallengeStore, capability, JOB_TTL, MAX_BODY_BYTES, ServiceError } from "./security.ts";
import { bootstrapOwner, initializeLocalRuntime, isLocal, persistRuntime } from "./runtime.ts";
import { derivePublicKey } from "../src/eddsa.mjs";
import { generatePrivateKey, savePrivateKey } from "../src/key-management.mjs";
import { transactionWallet } from "../src/blockchain.ts";
import { createValidationRunner } from "./validation.ts";
import { artifactPaths } from "../src/zkp.mjs";
import { walletDeployments } from "./wallet-deployment.ts";

export interface WebRuntime {
  deployment?: DeploymentRecord;
  experimental: boolean;
  signingEnabled: boolean;
  allowedRegistrants: string[];
  sourceId: string;
  sourceKeyFile: string;
  sourcesFile: string;
  walletRpcUrl: string;
  runtimeFile?: string;
  sourceKeys?: Record<string, string>;
}

interface ProofJob {
  token: string; address: Address; contentHash: string; expires: number;
  stage: string; history: string[]; result?: unknown; error?: { code: string; message: string };
  worker?: ReturnType<typeof fork>; snapshot: Record<string, unknown>;
}
type ProverMessage = { type: "stage"; stage: string } | { type: "result"; result: unknown } | { type: "error"; code: string };

// El proxy nunca permite transacciones ni métodos de administración del nodo.
const READ_METHODS = new Set(["eth_chainId", "eth_getCode", "eth_call", "eth_blockNumber", "eth_getBlockByNumber", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getLogs", "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "web3_clientVersion"]);

/** Devuelve JSON sin caché y conserva con exactitud todos los enteros criptográficos. */
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(stringifyCrypto(value));
}

/** Lee exclusivamente JSON pequeño; rechaza subidas multimedia y cuerpos de tamaño ilimitado. */
async function body(request: IncomingMessage) {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new ServiceError("BAD_REQUEST", "El servicio solo recibe JSON; el archivo permanece en el navegador.", 415);
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ServiceError("TOO_LARGE", "La solicitud excede el tamaño permitido.", 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ServiceError("BAD_REQUEST", "El cuerpo no es JSON válido."); }
}

/** Crea una aplicación aislable para la web y las pruebas con contratos reales. */
export async function createApplication(connection: BlockchainConnection, runtime: WebRuntime, origin: string, onShutdown?: () => Promise<void>) {
  const client = await connection.viem.getPublicClient();
  const challenges = new ChallengeStore();
  const jobs = new Map<string, ProofJob>();
  const plans = new Map<string, { address: Address; sources: unknown; root: string; expires: number; sourceKeys?: Record<string, string> }>();
  const localSessions = new Map<string, { address: Address; expires: number }>();
  const local = await isLocal(connection);
  const validation = createValidationRunner();
  const walletDeployment = walletDeployments(connection, runtime);
  const quotas = new Map<string, { expires: number; count: number }>();
  let running = false;
  let closing = false;
  const allowedHost = new URL(origin).host;

  /** Exige un despliegue real antes de cualquier operación de contenido. */
  function deployment() { if (!runtime.deployment) throw new ServiceError("DEPLOYMENT_REQUIRED", "Prepara el sistema desde Administración.", 409); return runtime.deployment; }

  /** Consulta el estado efectivo y diferencia una falla RPC de la ausencia de un registro. */
  async function configuration() {
    try { return await readRegistryConfiguration(connection, deployment().registryAddress); }
    catch { throw new ServiceError("RPC_UNAVAILABLE", "No se pudo consultar el registro. Comprueba el nodo y el despliegue.", 503); }
  }

  /** Restringe la emisión a cuentas admitidas y la administración al propietario actual del contrato. */
  async function assertPermission(address: string, action: string) {
    const canonical = canonicalAddress(address, "cuenta");
    if (action === "proof") {
      if (!runtime.signingEnabled) throw new ServiceError("SIGNING_DISABLED", "El servicio de autorización está deshabilitado.", 403);
      if (!runtime.allowedRegistrants.some(/* Compara direcciones normalizadas sin publicar la lista de permisos. */ (item) => item.toLowerCase() === canonical)) throw new ServiceError("NOT_AUTHORIZED", "Esta cuenta no tiene permiso para solicitar autorizaciones.", 403);
    } else if (action === "bootstrap") {
      if (!local || (await bootstrapOwner(connection)).toLowerCase() !== canonical) throw new ServiceError("ADMIN_ONLY", "La preparación requiere la cuenta administradora local.", 403);
    } else if (action === "wallet-deploy") {
      if (runtime.deployment) {
        const currentOwner = (await configuration()).owner;
        if (currentOwner.toLowerCase() !== canonical) throw new ServiceError("ADMIN_ONLY", "Un nuevo despliegue requiere la cuenta administradora actual.", 403);
      }
    } else if (action === "shutdown" && local && (await bootstrapOwner(connection)).toLowerCase() === canonical) {
      return canonical as Address;
    } else if (["admin-prepare", "admin-commit", "admin-sources", "admin-change", "admin-policy", "diagnostics", "shutdown"].includes(action)) {
      if ((await configuration()).owner.toLowerCase() !== canonical) throw new ServiceError("ADMIN_ONLY", "Esta operación requiere la cuenta administradora.", 403);
    } else throw new ServiceError("BAD_REQUEST", "La acción solicitada no existe.");
    return canonical as Address;
  }

  /** Comprueba un permiso vinculado al cuerpo de esta solicitud y revalida su rol actual. */
  async function authenticate(value: { challengeId: string; signature: Hex; payload: unknown }, action: string) {
    exactKeys(value, ["challengeId", "signature", "payload"], "permiso");
    const address = await challenges.consume(value.challengeId, value.signature, action, value.payload,
      /* Verifica también wallets de contrato compatibles con el proveedor EVM. */ async (account, message, signature) => client.verifyMessage({ address: account, message, signature }));
    await assertPermission(address, action);
    return address;
  }

  /** Libera resultados vencidos y limita las solicitudes por dirección de transporte. */
  function prune() {
    const now = Date.now();
    for (const [id, job] of jobs) if (job.expires < now) { job.worker?.kill(); jobs.delete(id); }
    for (const [id, plan] of plans) if (plan.expires < now) plans.delete(id);
    for (const [id, quota] of quotas) if (quota.expires < now) quotas.delete(id);
    for (const [id, session] of localSessions) if (session.expires < now) localSessions.delete(id);
  }

  /** Ejecuta un trabajador a la vez y conserva solamente etapas y resultados públicos del prover. */
  function pump() {
    if (running || closing) return;
    for (const [id, job] of jobs) {
      if (job.stage !== "queued") continue;
      running = true;
      const worker = fork(new URL("./prover-worker.mjs", import.meta.url), [], { execArgv: [], serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"] });
      worker.send(job.snapshot);
      job.worker = worker;
      let finished = false;
      /** Finaliza el trabajador sin imprimir datos de autorización ni errores internos. */
      function finish() {
        if (finished) return;
        finished = true;
        running = false;
        job.worker = undefined;
        worker.kill();
        if (jobs.has(id)) job.snapshot = {};
        pump();
      }
      /** Recibe únicamente etapas conocidas o el paquete público producido por el trabajador. */
      worker.on("message", (packet) => {
        if (!packet || typeof packet !== "object") return;
        const message = packet as ProverMessage;
        if (!jobs.has(id)) { finish(); return; }
        if (message.type === "stage" && ["authorizing", "authorized", "witness", "proving", "verifying"].includes(message.stage)) {
          job.stage = message.stage;
          job.history.push(message.stage);
        } else if (message.type === "result") { job.result = message.result; job.stage = "ready"; job.history.push("ready"); finish(); }
        else if (message.type === "error") {
          job.stage = "error";
          job.error = { code: message.code, message: message.code === "ROOT_CHANGED" ? "La raíz autorizada cambió. Prepara otra solicitud." : "No se pudo autorizar o generar la prueba. Comprueba la fuente y los artefactos del servicio." };
          finish();
        }
      });
      /** Clasifica una falla del trabajador sin exponer su excepción o su memoria. */
      worker.on("error", () => { job.stage = "error"; job.error = { code: "PROVER_UNAVAILABLE", message: "El servicio prover no pudo completar el trabajo." }; finish(); });
      /** Detecta una salida prematura, incluida una cancelación solicitada por el cliente. */
      worker.on("exit", () => { if (!finished) { job.stage = "error"; job.error = { code: "PROVER_UNAVAILABLE", message: "El trabajo fue interrumpido." }; finish(); } });
      break;
    }
  }

  /** Valida un token de capacidad sin permitir enumerar trabajos de otras cuentas. */
  function jobFor(request: IncomingMessage, id: string) {
    const job = jobs.get(id);
    if (!job || request.headers.authorization !== "Bearer " + job.token) throw new ServiceError("NOT_FOUND", "El trabajo no existe o no tienes acceso.", 404);
    return job;
  }

  /** Atiende la API; devuelve false cuando la petición corresponde a un recurso de la interfaz. */
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", origin);
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/rpc") return false;
    try {
      prune();
      if (request.headers.host !== allowedHost || (request.headers.origin && request.headers.origin !== origin)) throw new ServiceError("ORIGIN_DENIED", "El origen de la solicitud no está permitido.", 403);
      if (request.method !== "GET" && url.pathname !== "/rpc" && request.headers.origin !== origin) throw new ServiceError("ORIGIN_DENIED", "La operación requiere el origen de la aplicación.", 403);
      if (request.method === "GET" && url.pathname === "/api/config") {
        const registryAbi = (await artifacts.readArtifact("ContentRegistry")).abi;
        let current;
        try { await checkDeployment(connection, deployment()); current = await configuration(); } catch { current = undefined; }
        if (!current) {
          json(response, 200, { deploymentReady: false, localWalletAvailable: local, bootstrapOwner: local ? await bootstrapOwner(connection) : runtime.deployment?.owner,
            network: connection.networkName, chainId: String(await client.getChainId()), registryAddress: null, verifierAddress: null,
            root: "", rootEnabled: false, experimental: false, signingEnabled: false, registryAbi,
            walletDeploymentAvailable: true, explorerUrl: connection.networkName === "amoy" ? "https://amoy.polygonscan.com" : null,
            walletRpcUrl: runtime.walletRpcUrl, rpcPath: "/rpc", maxFileBytes: 25 * 1024 * 1024, protocolVersion: "1" });
          return true;
        }
        const manifest = JSON.parse(await readFile(artifactPaths().manifest, "utf8"));
        json(response, 200, { network: deployment().network, chainId: deployment().chainId,
          deploymentReady: true, localWalletAvailable: local,
          walletDeploymentAvailable: true, explorerUrl: connection.networkName === "amoy" ? "https://amoy.polygonscan.com" : null,
          tools: manifest.versions, circuitMetrics: manifest.metrics, setup: manifest.setup,
          registryAddress: deployment().registryAddress, verifierAddress: deployment().verifierAddress,
          artifactId: deployment().artifactId, experimental: runtime.experimental, signingEnabled: runtime.signingEnabled,
          walletRpcUrl: runtime.walletRpcUrl, rpcPath: "/rpc", registryAbi, maxFileBytes: 25 * 1024 * 1024,
          owner: current.owner, pendingOwner: current.pendingOwner, root: current.root, rootEnabled: current.rootEnabled, protocolVersion: current.protocolVersion, protocolDomain: current.protocolDomain });
      } else if (request.method === "GET" && url.pathname === "/api/local-wallet/accounts") {
        if (!local) throw new ServiceError("LOCAL_ONLY", "No hay cuentas experimentales en esta red.", 403);
        json(response, 200, { accounts: (await connection.viem.getWalletClients()).map(/* Publica únicamente direcciones de cuentas de desarrollo, nunca sus claves. */ (wallet) => wallet.account.address) });
      } else if (request.method === "POST" && url.pathname === "/api/local-wallet/connect") {
        const value = await body(request);
        if (!local || value.experimental !== true || new URL(origin).hostname !== "127.0.0.1") throw new ServiceError("LOCAL_ONLY", "La cuenta experimental solo se habilita explícitamente en el nodo local.", 403);
        if (value.previousToken) localSessions.delete(value.previousToken);
        if (localSessions.size >= 32) throw new ServiceError("BUSY", "Hay demasiadas sesiones locales.", 429);
        const wallets = await connection.viem.getWalletClients();
        const wallet = value.address ? wallets.find(/* Permite seleccionar solo cuentas ya existentes en el nodo de desarrollo. */ (candidate) => candidate.account.address.toLowerCase() === canonicalAddress(value.address, "cuenta experimental")) : wallets[0];
        if (!wallet) throw new ServiceError("LOCAL_ONLY", "La cuenta no pertenece al nodo de desarrollo.", 403);
        const token = capability();
        localSessions.set(token, { address: wallet.account.address, expires: Date.now() + 3_600_000 });
        json(response, 200, { token, address: wallet.account.address });
      } else if (request.method === "POST" && url.pathname === "/api/local-wallet/request") {
        const value = await body(request);
        const session = localSessions.get(value.token);
        if (!local || !session) throw new ServiceError("LOCAL_ONLY", "La sesión experimental venció.", 401);
        if (["eth_accounts", "eth_requestAccounts"].includes(value.method)) json(response, 200, { result: [session.address] });
        else if (value.method === "eth_chainId") json(response, 200, { result: "0x7a69" });
        else if (["wallet_switchEthereumChain", "wallet_addEthereumChain"].includes(value.method)) {
          if (value.params?.[0]?.chainId !== "0x7a69") throw new ServiceError("LOCAL_ONLY", "La cuenta experimental solo usa la cadena local.", 403);
          json(response, 200, { result: null });
        } else if (value.method === "personal_sign") {
          const message = hexToString(value.params?.[0]);
          if (!message.startsWith("TRAZA — Permiso para una operación\nOrigen: " + origin + "\n")) throw new ServiceError("AUTH_INVALID", "La cuenta local solo firma permisos de esta aplicación.", 403);
          const wallet = (await connection.viem.getWalletClients()).find(/* Selecciona exclusivamente la cuenta a la que se otorgó esta sesión. */ (candidate) => candidate.account.address.toLowerCase() === session.address.toLowerCase());
          if (!wallet) throw new ServiceError("LOCAL_ONLY", "La cuenta experimental ya no está disponible.", 401);
          json(response, 200, { result: await wallet.signMessage({ message }) });
        } else if (value.method === "eth_sendTransaction") {
          const tx = value.params?.[0];
          if (!tx || tx.from?.toLowerCase() !== session.address.toLowerCase() || BigInt(tx.value ?? "0x0") !== 0n) throw new ServiceError("LOCAL_ONLY", "La cuenta experimental solo envía operaciones de valor cero al protocolo.", 403);
          if (tx.to?.toLowerCase() !== runtime.deployment?.registryAddress.toLowerCase()) {
            if (!await walletDeployment.allowsTransaction(session.address, tx.to, tx.data)) throw new ServiceError("LOCAL_ONLY", "La transacción no corresponde a un despliegue autorizado.", 403);
            json(response, 200, { result: await client.request({ method: "eth_sendTransaction", params: [tx] } as never) });
            return true;
          }
          const decoded = decodeFunctionData({ abi: (await artifacts.readArtifact("ContentRegistry")).abi, data: tx.data });
          if (!["register", "setAuthorizedSourcesRoot", "disableAuthorizedSourcesRoot", "transferOwnership", "acceptOwnership"].includes(decoded.functionName)) throw new ServiceError("LOCAL_ONLY", "La función no está permitida.", 403);
          json(response, 200, { result: await client.request({ method: "eth_sendTransaction", params: [tx] } as never) });
        } else if (READ_METHODS.has(value.method)) json(response, 200, { result: await client.request({ method: value.method, params: value.params } as never) });
        else throw new ServiceError("LOCAL_ONLY", "La cuenta experimental no permite ese método.", 403);
      } else if (request.method === "POST" && url.pathname === "/api/deployment/prepare") {
        const value = await body(request);
        const address = await authenticate(value, "wallet-deploy");
        exactKeys(value.payload, ["developmentSource"], "preparación de despliegue");
        if (value.payload.developmentSource !== true) throw new ServiceError("DEVELOPMENT_SOURCE_REQUIRED", "Confirma el uso de una fuente y un setup de desarrollo para este ensayo.", 409);
        json(response, 200, await walletDeployment.prepare(address));
      } else if (request.method === "POST" && url.pathname === "/api/deployment/progress") {
        const value = await body(request);
        exactKeys(value, ["planId", "planToken", "kind", "transactionHash"], "avance de despliegue");
        json(response, 200, await walletDeployment.progress(value.planId, value.planToken, value.kind, value.transactionHash));
      } else if (request.method === "POST" && url.pathname === "/api/deployment/commit") {
        const value = await body(request);
        const address = await authenticate(value, "wallet-deploy");
        exactKeys(value.payload, ["planId", "planToken", "verifierTransaction", "registryTransaction", "rootTransaction"], "confirmación de despliegue");
        json(response, 200, await walletDeployment.commit(address, value.payload));
      } else if (request.method === "POST" && url.pathname === "/api/bootstrap") {
        const value = await body(request);
        const address = await authenticate(value, "bootstrap");
        if (value.payload.experimental !== true) throw new ServiceError("LOCAL_ONLY", "Confirma explícitamente el entorno experimental local.", 403);
        Object.assign(runtime, await initializeLocalRuntime(connection, [address]));
        json(response, 200, { ready: true, registryAddress: deployment().registryAddress });
      } else if (request.method === "POST" && url.pathname === "/rpc") {
        const rpc = await body(request);
        if (Array.isArray(rpc) || rpc.jsonrpc !== "2.0" || !READ_METHODS.has(rpc.method)) throw new ServiceError("RPC_METHOD_DENIED", "El proxy solo permite consultas de lectura del protocolo.", 403);
        if (rpc.method === "eth_getLogs") {
          const filter = rpc.params?.[0];
          if (typeof filter?.address !== "string" || filter.address.toLowerCase() !== deployment().registryAddress.toLowerCase()) throw new ServiceError("RPC_METHOD_DENIED", "Solo se consultan eventos del registro configurado.", 403);
        }
        try { json(response, 200, { jsonrpc: "2.0", id: rpc.id ?? null, result: await client.request({ method: rpc.method, params: rpc.params } as never) }); }
        catch { json(response, 200, { jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32000, message: "No se pudo completar la consulta RPC." } }); }
      } else if (request.method === "POST" && url.pathname === "/api/challenges") {
        const value = await body(request);
        exactKeys(value, ["address", "action", "payload"], "solicitud de permiso");
        const key = request.socket.remoteAddress ?? "local";
        const quota = quotas.get(key) ?? { expires: Date.now() + 60_000, count: 0 };
        if (++quota.count > 40) throw new ServiceError("RATE_LIMIT", "Demasiadas solicitudes; espera un minuto.", 429);
        quotas.set(key, quota);
        const address = await assertPermission(value.address, value.action);
        json(response, 201, challenges.issue(address, value.action, value.payload, origin, String(await client.getChainId()), runtime.deployment?.registryAddress ?? "Pendiente de despliegue"));
      } else if (request.method === "POST" && url.pathname === "/api/proofs") {
        const value = await body(request);
        const address = await authenticate(value, "proof");
        exactKeys(value.payload, ["contentHash"], "contenido");
        const contentHash = parseField(value.payload.contentHash, "contentHash").toString();
        if (jobs.size >= 32 || [...jobs.values()].filter(/* Cuenta solo trabajos que todavía requieren procesamiento. */ (job) => !["ready", "error"].includes(job.stage)).length >= 4) throw new ServiceError("BUSY", "El prover está ocupado. Inténtalo nuevamente.", 429);
        const current = await configuration();
        if (!current.rootEnabled) throw new ServiceError("ROOT_DISABLED", "La raíz de autorización está deshabilitada.", 409);
        if ((await queryContent(connection, deployment().registryAddress, contentHash)).exists) throw new ServiceError("DUPLICATE_CONTENT", "El archivo ya tiene un registro aceptado.", 409);
        const id = randomUUID();
        const token = capability();
        const sources = JSON.parse(await readFile(runtime.sourcesFile, "utf8"));
        const source = sources.find(/* Elige solo una fuente aún autorizada cuya clave permanece en el servidor. */ (entry: { sourceId: string }) => entry.sourceId === runtime.sourceId && (runtime.sourceKeys?.[entry.sourceId] || runtime.sourceKeyFile)) ?? sources.find(/* Busca otra fuente local disponible después de una revocación. */ (entry: { sourceId: string }) => runtime.sourceKeys?.[entry.sourceId]);
        if (!source) throw new ServiceError("SOURCE_UNAVAILABLE", "No hay una fuente con clave disponible en el conjunto actual.", 409);
        jobs.set(id, { token, address, contentHash, expires: Date.now() + JOB_TTL, stage: "queued", history: [],
          snapshot: { sourceId: source.sourceId, sourceKeyFile: runtime.sourceKeys?.[source.sourceId] ?? runtime.sourceKeyFile, sourcesFile: runtime.sourcesFile,
            expectedRoot: current.root.toString(), operation: { contentHash, protocolVersion: current.protocolVersion.toString(),
              context: { registrant: address, chainId: current.chainId.toString(), registryAddress: current.registryAddress, protocolDomain: current.protocolDomain.toString() } } } });
        pump();
        json(response, 202, { jobId: id, jobToken: token });
      } else if (["GET", "DELETE"].includes(request.method ?? "") && url.pathname.startsWith("/api/proofs/")) {
        const id = url.pathname.slice("/api/proofs/".length);
        const job = jobFor(request, id);
        if (request.method === "DELETE") { jobs.delete(id); job.worker?.kill(); json(response, 200, { cancelled: true }); }
        else json(response, 200, { stage: job.stage, history: job.history, ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}) });
      } else if (request.method === "POST" && url.pathname === "/api/admin/sources") {
        const value = await body(request);
        await authenticate(value, "admin-sources");
        const sources = runtime.sourcesFile ? JSON.parse(await readFile(runtime.sourcesFile, "utf8")) : [];
        json(response, 200, { sources: sources.map(/* Devuelve únicamente datos operativos al administrador autenticado. */ (entry: { sourceId: string; publicKey: string[] }) => ({ sourceId: entry.sourceId, publicKey: entry.publicKey, available: Boolean(runtime.sourceKeys?.[entry.sourceId] || entry.sourceId === runtime.sourceId && runtime.sourceKeyFile) })), allowedRegistrants: runtime.allowedRegistrants, signingEnabled: runtime.signingEnabled });
      } else if (request.method === "POST" && url.pathname === "/api/admin/policy") {
        const value = await body(request);
        await authenticate(value, "admin-policy");
        exactKeys(value.payload, ["allowedRegistrants", "signingEnabled"], "política de emisión");
        if (!Array.isArray(value.payload.allowedRegistrants) || value.payload.allowedRegistrants.length > 256 || typeof value.payload.signingEnabled !== "boolean") throw new ServiceError("BAD_REQUEST", "La política de emisión no es válida.");
        const permitted = value.payload.allowedRegistrants.map(/* Normaliza cada cuenta admitida por el administrador. */ (address: string) => canonicalAddress(address, "registrante"));
        if (value.payload.signingEnabled && (!runtime.sourceKeyFile || !runtime.sourcesFile)) throw new ServiceError("SOURCE_UNAVAILABLE", "Configura una fuente antes de habilitar la emisión.", 409);
        runtime.allowedRegistrants = permitted;
        runtime.signingEnabled = value.payload.signingEnabled;
        await persistRuntime(runtime);
        json(response, 200, { saved: true });
      } else if (request.method === "POST" && url.pathname === "/api/admin/change") {
        const value = await body(request);
        const address = await authenticate(value, "admin-change");
        exactKeys(value.payload, ["kind", "sourceId"], "cambio de fuente");
        const sourceId = parseField(value.payload.sourceId, "sourceId").toString();
        if (sourceId === "0" || !["create", "rotate", "revoke"].includes(value.payload.kind) || !runtime.sourcesFile) throw new ServiceError("BAD_REQUEST", "La operación de fuente no es válida.");
        const sources = JSON.parse(await readFile(runtime.sourcesFile, "utf8"));
        const position = sources.findIndex(/* Localiza solo el identificador validado por el administrador. */ (entry: { sourceId: string }) => entry.sourceId === sourceId);
        if (value.payload.kind === "create" && position >= 0 || value.payload.kind !== "create" && position < 0) throw new ServiceError("SOURCE_CONFLICT", "La fuente no existe o su identificador ya está ocupado.", 409);
        const sourceKeys = { [runtime.sourceId]: runtime.sourceKeyFile, ...runtime.sourceKeys };
        if (value.payload.kind === "revoke") sources.splice(position, 1);
        else {
          if (!runtime.sourceKeyFile) throw new ServiceError("KEY_STORAGE_UNAVAILABLE", "No hay almacenamiento privado de claves configurado para crear fuentes.", 409);
          const seed = generatePrivateKey();
          try {
            const filename = path.join(path.dirname(runtime.sourceKeyFile), "source-" + randomUUID() + ".json");
            await savePrivateKey(filename, seed);
            const entry = { sourceId, publicKey: await derivePublicKey(seed) };
            if (position < 0) sources.push(entry); else sources[position] = entry;
            sourceKeys[sourceId] = filename;
          } finally { seed.fill(0); }
        }
        const tree = await buildAuthorizedSourcesTree(sources);
        const planId = randomUUID();
        plans.set(planId, { address, sources: tree.sources, root: tree.root.toString(), sourceKeys, expires: Date.now() + JOB_TTL });
        json(response, 200, { planId, root: tree.root, count: tree.sources.length });
      } else if (request.method === "POST" && url.pathname === "/api/admin/prepare") {
        const value = await body(request);
        const address = await authenticate(value, "admin-prepare");
        exactKeys(value.payload, ["sources"], "conjunto autorizado");
        if (!runtime.sourcesFile) throw new ServiceError("ADMIN_UNAVAILABLE", "No hay un archivo de fuentes configurado para este servicio.", 409);
        if (plans.size >= 8) throw new ServiceError("BUSY", "Hay demasiados conjuntos pendientes.", 429);
        const tree = await buildAuthorizedSourcesTree(value.payload.sources);
        const planId = randomUUID();
        plans.set(planId, { address, sources: tree.sources, root: tree.root.toString(), expires: Date.now() + JOB_TTL });
        json(response, 200, { planId, root: tree.root, count: tree.sources.length });
      } else if (request.method === "POST" && url.pathname === "/api/admin/commit") {
        const value = await body(request);
        const address = await authenticate(value, "admin-commit");
        exactKeys(value.payload, ["planId"], "confirmación de conjunto");
        const plan = plans.get(value.payload.planId);
        if (!plan || plan.address !== address) throw new ServiceError("NOT_FOUND", "El conjunto preparado venció o no corresponde a tu cuenta.", 404);
        const current = await configuration();
        if (!current.rootEnabled || current.root.toString() !== plan.root) throw new ServiceError("ROOT_NOT_CONFIRMED", "Confirma primero la transacción de esa raíz en el contrato.", 409);
        const temporary = runtime.sourcesFile + "." + randomUUID() + ".tmp";
        await writeFile(temporary, stringifyCrypto(plan.sources) + "\n", { flag: "wx", mode: 0o600 });
        await rename(temporary, runtime.sourcesFile);
        if (plan.sourceKeys) runtime.sourceKeys = plan.sourceKeys;
        await persistRuntime(runtime);
        plans.delete(value.payload.planId);
        json(response, 200, { root: plan.root, synchronized: true });
      } else if (request.method === "POST" && url.pathname === "/api/admin/validate") {
        const value = await body(request);
        await authenticate(value, "diagnostics");
        if (!local) throw new ServiceError("LOCAL_ONLY", "El ensayo completo se ejecuta únicamente en el entorno local.", 403);
        json(response, 202, validation.start());
      } else if (request.method === "GET" && url.pathname.startsWith("/api/admin/validate/")) {
        json(response, 200, validation.read(url.pathname.slice("/api/admin/validate/".length), request.headers.authorization));
      } else if (request.method === "POST" && url.pathname === "/api/shutdown") {
        const value = await body(request);
        await authenticate(value, "shutdown");
        if (!local || !onShutdown) throw new ServiceError("LOCAL_ONLY", "El cierre desde la aplicación solo está disponible en el entorno local.", 403);
        json(response, 200, { stopping: true });
        setTimeout(/* Permite entregar la confirmación antes de cerrar los procesos propios. */ () => { void onShutdown(); }, 250);
      } else throw new ServiceError("NOT_FOUND", "La operación solicitada no existe.", 404);
    } catch (error) {
      const controlled = error instanceof ServiceError ? error : new ServiceError("REQUEST_FAILED", error instanceof TypeError || error instanceof RangeError ? "La estructura o los valores de la solicitud no son válidos." : "No se pudo completar la operación del servicio.", 400);
      if (!response.headersSent) json(response, controlled.status, { error: { code: controlled.code, message: controlled.message } });
      else response.end();
    }
    return true;
  }

  /** Detiene únicamente los trabajos de esta aplicación y descarta sus resultados en memoria. */
  async function close() { closing = true; validation.close(); await Promise.all([...jobs.values()].map(/* Cierra cada trabajador activo sin escribir su testigo. */ (job) => job.worker?.kill())); jobs.clear(); plans.clear(); }

  return { handle, close };
}
