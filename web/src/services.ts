/** Separa el procesamiento de archivos, los permisos, el prover y los clientes EVM de los componentes visuales. */

import { createPublicClient, createWalletClient, custom, defineChain, encodeFunctionData, getContract, http, toHex } from "viem";
import type { Address, EIP1193Provider, Hash, Hex } from "viem";
import type { Configuration, ContentRecord, ProofResult, PublicReceipt, Stage, WalletProvider } from "./types.ts";
import { ApplicationError } from "./errors.ts";

// La cuenta de laboratorio solo existe después de una elección explícita y su token permanece en memoria.
let localProvider: WalletProvider | undefined;
let localSessionToken: string | undefined;
let selectedNetwork = "localhost";

/** Recupera únicamente la preferencia pública de red, sin conservar permisos ni claves en almacenamiento local. */
export function getSelectedNetwork() { try { const saved = window.localStorage?.getItem("traza-network"); if (saved === "localhost" || saved === "amoy") selectedNetwork = saved; } catch { /* Un navegador sin almacenamiento conserva la selección en memoria. */ } return selectedNetwork; }

/** Cambia el destino de lectura y descarta la cuenta de laboratorio antes de utilizar otra cadena. */
export function selectNetwork(name: string) { if (!["localhost", "amoy"].includes(name)) throw new ApplicationError("WrongChain"); selectedNetwork = name; localProvider = undefined; try { window.localStorage?.setItem("traza-network", name); } catch { /* La persistencia es opcional. */ } }

/** Identifica si la cuenta actual pertenece al laboratorio y debe desconectarse al salir de la red local. */
export function usingLocalWallet() { return Boolean(localProvider); }

/** Descarta la sesión local del navegador sin alterar permisos ni desconectar otras aplicaciones de la wallet. */
export function disconnectWallet() { localProvider = undefined; }

/** Habilita una sesión limitada al registro del nodo local; no incorpora ninguna clave privada al navegador. */
export async function activateLocalWallet(address?: Address) {
  const session = await api<{ token: string; address: Address }>("/api/local-wallet/connect", { method: "POST", body: JSON.stringify({ experimental: true, address, previousToken: localSessionToken }) });
  localSessionToken = session.token;
  localProvider = { request: /* Envía únicamente métodos de la sesión local controlada por el servidor. */ async ({ method, params }) => (await api<{ result: unknown }>("/api/local-wallet/request", { method: "POST", body: JSON.stringify({ token: session.token, method, params }) })).result };
  return session.address;
}

/** Envía JSON al mismo origen y conserva solo los errores públicos definidos por el servicio. */
export async function api<T>(route: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(route, { ...options, headers: { "Content-Type": "application/json", "X-Traza-Network": selectedNetwork, ...options.headers }, cache: "no-store" }); }
  catch { throw new ApplicationError("SERVICE_UNAVAILABLE", "No se pudo conectar con el servicio de la aplicación."); }
  const value = await response.json().catch(/* Clasifica una respuesta no JSON sin mostrar el cuerpo del servidor. */ () => ({}));
  if (!response.ok) throw new ApplicationError(value.error?.code ?? "SERVICE_ERROR", value.error?.message ?? "El servicio no pudo completar la operación.");
  return value as T;
}

/** Obtiene la configuración del despliegue real sin incorporar direcciones en los componentes. */
export function getConfiguration(network = selectedNetwork) { return api<Configuration>("/api/config", { headers: { "X-Traza-Network": network } }); }

/** Define la red de todos los clientes a partir de una sola configuración pública. */
export function configuredChain(config: Configuration) {
  return defineChain({ id: Number(config.chainId), name: config.network === "amoy" ? "Polygon Amoy" : config.network, nativeCurrency: { name: config.network === "amoy" ? "POL" : "Ether de desarrollo", symbol: config.network === "amoy" ? "POL" : "ETH", decimals: 18 }, rpcUrls: { default: { http: [config.walletRpcUrl] } } });
}

/** Crea un cliente de lectura que no solicita permisos a la wallet ni expone credenciales RPC. */
export function publicClient(config: Configuration) {
  return createPublicClient({ chain: configuredChain(config), transport: http(new URL(config.rpcPath, window.location.origin).href, { timeout: 15_000, retryCount: 1, fetchOptions: { headers: { "X-Traza-Network": config.network } } }) });
}

/** Estima la operación exacta y añade un 20 % de margen, sin superar el gas permitido por el bloque. */
export async function estimateOperationGas(config: Configuration, account: Address, data: Hex, to?: Address) {
  const client = publicClient(config);
  const [estimate, block] = await Promise.all([client.estimateGas({ account, data, to, value: 0n }), client.getBlock({ blockTag: "latest" })]);
  if (estimate <= 0n || block.gasLimit <= 0n || estimate > block.gasLimit) throw new ApplicationError("GAS_LIMIT_EXCEEDED", "El gas necesario para esta operación supera el límite disponible en la red.");
  // La división redondea hacia arriba para conservar el margen también con cantidades que no sean múltiplos de cinco.
  const buffered = estimate + (estimate + 4n) / 5n;
  return buffered > block.gasLimit ? block.gasLimit : buffered;
}

/** Exige un proveedor de wallet sin utilizar cuentas desbloqueadas del servidor para registrar contenido. */
export function walletProvider(): WalletProvider {
  if (localProvider) return localProvider;
  if (!window.ethereum) throw new ApplicationError("WalletMissing");
  return window.ethereum;
}

/** Solicita la cuenta y la cadena actuales al proveedor EIP-1193 conectado. */
export async function connectWallet() {
  const provider = walletProvider();
  const accounts = await provider.request({ method: "eth_requestAccounts" }) as Address[];
  if (!accounts[0]) throw new ApplicationError("WalletDisconnected");
  const chainId = BigInt(await provider.request({ method: "eth_chainId" }) as string).toString();
  return { address: accounts[0], chainId };
}

/** Valida la cuenta y la red justo antes de firmar o enviar una transacción. */
export async function currentWallet(config: Configuration, expected?: Address) {
  const provider = walletProvider();
  const accounts = await provider.request({ method: "eth_accounts" }) as Address[];
  if (!accounts[0]) throw new ApplicationError("WalletDisconnected");
  if (expected && accounts[0].toLowerCase() !== expected.toLowerCase()) throw new ApplicationError("WrongRegistrant");
  if (BigInt(await provider.request({ method: "eth_chainId" }) as string).toString() !== config.chainId) throw new ApplicationError("WrongChain");
  return { address: accounts[0], client: createWalletClient({ account: accounts[0], chain: configuredChain(config), transport: custom(provider as EIP1193Provider) }) };
}

/** Solicita cambiar de red o agregar la red configurada si la wallet todavía no la conoce. */
export async function switchNetwork(config: Configuration) {
  const provider = walletProvider();
  try { await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHex(Number(config.chainId)) }] }); }
  catch (error) {
    if ((error as { code?: number }).code !== 4902) throw error;
    const chain = configuredChain(config);
    await provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: toHex(chain.id), chainName: chain.name, rpcUrls: [config.walletRpcUrl], nativeCurrency: chain.nativeCurrency }] });
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHex(chain.id) }] });
  }
}

/** Firma un permiso de un solo uso sin transferir la clave de la wallet al servicio. */
export async function authorizedRequest<T>(config: Configuration, action: string, route: string, payload: unknown) {
  const wallet = await currentWallet(config);
  const challenge = await api<{ id: string; message: string }>("/api/challenges", { method: "POST", headers: { "X-Traza-Network": config.network }, body: JSON.stringify({ address: wallet.address, action, payload }) });
  const signature = await wallet.client.signMessage({ message: challenge.message });
  await currentWallet(config, wallet.address);
  return api<T>(route, { method: "POST", headers: { "X-Traza-Network": config.network }, body: JSON.stringify({ challengeId: challenge.id, signature, payload }) });
}

/** Procesa los bytes exactos en un trabajador cancelable y comunica únicamente progreso real de lectura. */
export function hashFile(file: File, onProgress: (processed: number, total: number) => void, signal?: AbortSignal): Promise<string> {
  return new Promise(/* Coordina el resultado y la cancelación de un trabajador independiente. */ (resolve, reject) => {
    const worker = new Worker(new URL("./hash.worker.ts", import.meta.url), { type: "module" });
    /** Libera el trabajador y su manejador de cancelación al finalizar la lectura. */
    function cleanup() { worker.terminate(); signal?.removeEventListener("abort", cancel); }
    /** Interrumpe el procesamiento al reemplazar o cancelar el archivo. */
    function cancel() { cleanup(); reject(new DOMException("Operación cancelada", "AbortError")); }
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener("abort", cancel, { once: true });
    /** Recibe progreso medido o una huella; los errores no incluyen bytes del archivo. */
    worker.onmessage = (event) => {
      if (event.data.type === "progress") onProgress(event.data.processed, event.data.total);
      else if (event.data.type === "result") { cleanup(); resolve(event.data.contentHash); }
      else { cleanup(); reject(new ApplicationError("HASH_FAILED", "No se pudo calcular la huella del archivo.")); }
    };
    /** Clasifica fallas de inicialización o carga WASM del trabajador. */
    worker.onerror = () => { cleanup(); reject(new ApplicationError("HASH_FAILED", "No se pudo iniciar el procesamiento Poseidon.")); };
    worker.postMessage({ file });
  });
}

/** Obtiene una prueba pública sin recibir firma EdDSA, identidad de fuente ni ruta Merkle en el navegador. */
export async function generateRegistrationProof(config: Configuration, contentHash: string, onStage: (stage: Stage) => void, signal?: AbortSignal): Promise<ProofResult> {
  onStage("permission");
  const job = await authorizedRequest<{ jobId: string; jobToken: string }>(config, "proof", "/api/proofs", { contentHash });
  const route = "/api/proofs/" + job.jobId;
  const headers = { Authorization: "Bearer " + job.jobToken, "X-Traza-Network": config.network };
  /** Cancela también el trabajo servidor sin guardar su token ni sus entradas en disco del navegador. */
  function cancel() { void api(route, { method: "DELETE", headers }).catch(/* La cancelación no reemplaza un resultado ya recibido. */ () => undefined); }
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) { cancel(); throw new DOMException("Operación cancelada", "AbortError"); }
      const value = await api<{ stage: Stage | "error"; error?: { code: string; message: string }; result?: ProofResult }>(route, { headers, signal });
      if (value.error) throw new ApplicationError(value.error.code, value.error.message);
      if (value.stage !== "error") onStage(value.stage);
      if (value.result) return value.result;
      await new Promise(/* Espera entre consultas sin bloquear la interfaz. */ (resolve) => setTimeout(resolve, 200));
    }
  } finally { signal?.removeEventListener("abort", cancel); }
}

/** Comprueba proveedor y código antes de cualquier lectura pública del registro. */
export async function registryClient(config: Configuration) {
  const client = publicClient(config);
  try {
    if (String(await client.getChainId()) !== config.chainId) throw new ApplicationError("WrongChain");
    const code = await client.getCode({ address: config.registryAddress });
    if (!code || code === "0x") throw new ApplicationError("ContractMissing");
    return client;
  } catch (error) { if (error instanceof ApplicationError) throw error; throw new ApplicationError("RPC_UNAVAILABLE"); }
}

/** Consulta una huella sin conectar wallet ni crear otra prueba de conocimiento cero. */
export async function queryRegistry(config: Configuration, contentHash: string): Promise<ContentRecord> {
  const client = await registryClient(config);
  try { return await client.readContract({ address: config.registryAddress, abi: config.registryAbi, functionName: "getRecord", args: [BigInt(contentHash)] }) as ContentRecord; }
  catch { throw new ApplicationError("RPC_UNAVAILABLE"); }
}

/** Envía una prueba con la wallet, espera el recibo y devuelve únicamente información pública de confirmación. */
export async function registerContent(config: Configuration, proof: ProofResult, onStage: (stage: Stage, transactionHash?: Hash) => void): Promise<PublicReceipt> {
  const expected = ("0x" + BigInt(proof.publicSignals[4]).toString(16).padStart(40, "0")) as Address;
  const wallet = await currentWallet(config, expected);
  if (proof.artifactId !== config.artifactId || proof.publicSignals[5] !== config.chainId || BigInt(proof.publicSignals[6]) !== BigInt(config.registryAddress)) throw new ApplicationError("InvalidProof");
  const client = await registryClient(config);
  const registry = getContract({ address: config.registryAddress, abi: config.registryAbi, client: { public: client, wallet: wallet.client } });
  const value = proof.solidity;
  const args = [value.pA.map(BigInt), value.pB.map(/* Convierte cada pareja manteniendo el orden exportado por snarkjs. */ (pair) => pair.map(BigInt)), value.pC.map(BigInt), value.publicSignals.map(BigInt)];
  await client.simulateContract({ address: registry.address, abi: registry.abi, functionName: "register", args, account: wallet.address });
  const gas = await estimateOperationGas(config, wallet.address, encodeFunctionData({ abi: registry.abi, functionName: "register", args }), registry.address);
  await currentWallet(config, expected);
  onStage("wallet");
  const start = performance.now();
  const hash = await registry.write.register(args, { gas });
  onStage("submitted", hash);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new ApplicationError("TX_REVERTED", "La transacción fue revertida. El archivo no quedó registrado.");
  onStage("confirmed", hash);
  return { transactionHash: hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, confirmationMs: performance.now() - start };
}

/** Publica o deshabilita una raíz mediante una transacción de la wallet administradora. */
export async function administerRoot(config: Configuration, root?: string): Promise<Hash> {
  const wallet = await currentWallet(config);
  if (wallet.address.toLowerCase() !== config.owner.toLowerCase()) throw new ApplicationError("Unauthorized");
  const client = await registryClient(config);
  const registry = getContract({ address: config.registryAddress, abi: config.registryAbi, client: { public: client, wallet: wallet.client } });
  const data = root === undefined ? encodeFunctionData({ abi: registry.abi, functionName: "disableAuthorizedSourcesRoot" }) : encodeFunctionData({ abi: registry.abi, functionName: "setAuthorizedSourcesRoot", args: [BigInt(root)] });
  const gas = await estimateOperationGas(config, wallet.address, data, registry.address);
  await currentWallet(config, wallet.address);
  const hash = root === undefined ? await registry.write.disableAuthorizedSourcesRoot([], { gas }) : await registry.write.setAuthorizedSourcesRoot([BigInt(root)], { gas });
  if ((await client.waitForTransactionReceipt({ hash })).status !== "success") throw new ApplicationError("TX_REVERTED", "La operación administrativa fue revertida.");
  return hash;
}

/** Propone o acepta una transferencia administrativa en las dos etapas exigidas por el contrato. */
export async function transferAdministrator(config: Configuration, proposed?: Address) {
  const wallet = await currentWallet(config);
  const client = await registryClient(config);
  const registry = getContract({ address: config.registryAddress, abi: config.registryAbi, client: { public: client, wallet: wallet.client } });
  const data = proposed ? encodeFunctionData({ abi: registry.abi, functionName: "transferOwnership", args: [proposed] }) : encodeFunctionData({ abi: registry.abi, functionName: "acceptOwnership" });
  const gas = await estimateOperationGas(config, wallet.address, data, registry.address);
  await currentWallet(config, wallet.address);
  const hash = proposed ? await registry.write.transferOwnership([proposed], { gas }) : await registry.write.acceptOwnership([], { gas });
  if ((await client.waitForTransactionReceipt({ hash })).status !== "success") throw new ApplicationError("TX_REVERTED", "La transferencia administrativa fue revertida.");
  return hash;
}
