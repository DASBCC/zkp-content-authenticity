/** Separa el procesamiento de archivos, los permisos, el prover y los clientes EVM de los componentes visuales. */

import { createPublicClient, createWalletClient, custom, defineChain, encodeFunctionData, getContract, http, toHex } from "viem";
import type { Address, EIP1193Provider, Hash, Hex } from "viem";
import type { Configuration, ContentRecord, ProofResult, PublicReceipt, Stage, WalletProvider } from "./types.ts";
import { ApplicationError } from "./errors.ts";

// La cuenta de laboratorio solo existe después de una elección explícita y su token permanece en memoria.
let localProvider: WalletProvider | undefined;
let localSessionToken: string | undefined;
let selectedNetwork = "localhost";

/**
 * Recupera únicamente la preferencia pública de red, sin conservar permisos ni claves en almacenamiento local.
 * Entradas. Sin argumentos. Consulta localStorage y la selección en memoria.
 * Salida. Nombre de red seleccionado.
 */
export function getSelectedNetwork() { try { const saved = window.localStorage?.getItem("traza-network"); if (saved === "localhost" || saved === "amoy") selectedNetwork = saved; } catch { /* Un navegador sin almacenamiento conserva la selección en memoria. */ } return selectedNetwork; }

/**
 * Cambia el destino de lectura y descarta la cuenta de laboratorio antes de utilizar otra cadena.
 * Entradas. Nombre de red admitido, localhost o amoy.
 * Salida. Sin valor de retorno. Actualiza la selección y descarta el proveedor de laboratorio.
 */
export function selectNetwork(name: string) { if (!["localhost", "amoy"].includes(name)) throw new ApplicationError("WrongChain"); selectedNetwork = name; localProvider = undefined; try { window.localStorage?.setItem("traza-network", name); } catch { /* La persistencia es opcional. */ } }

/**
 * Identifica si la cuenta actual pertenece al laboratorio y debe desconectarse al salir de la red local.
 * Entradas. Sin argumentos. Consulta el proveedor de laboratorio en memoria.
 * Salida. true si existe un proveedor local, o false en otro caso.
 */
export function usingLocalWallet() { return Boolean(localProvider); }

/**
 * Descarta la sesión local del navegador sin alterar permisos ni desconectar otras aplicaciones de la wallet.
 * Entradas. Sin argumentos. Usa el proveedor local activo.
 * Salida. Sin valor de retorno. Elimina la referencia al proveedor.
 */
export function disconnectWallet() { localProvider = undefined; }

/**
 * Inicia una sesión de wallet limitada al registro del nodo local.
 * Entradas. Dirección opcional de una cuenta de laboratorio.
 * Salida. Promesa de la dirección asignada por el servicio. También activa su proveedor local.
 */
export async function activateLocalWallet(address?: Address) {
  const session = await api<{ token: string; address: Address }>("/api/local-wallet/connect", { method: "POST", body: JSON.stringify({ experimental: true, address, previousToken: localSessionToken }) });
  localSessionToken = session.token;
  localProvider = { request: /* Adapta el proveedor local a la interfaz de wallet del navegador. Entradas. Objeto con método EIP-1193 y parámetros opcionales. Salida. Promesa del resultado RPC del servicio para esa sesión. */ async ({ method, params }) => (await api<{ result: unknown }>("/api/local-wallet/request", { method: "POST", body: JSON.stringify({ token: session.token, method, params }) })).result };
  return session.address;
}

/**
 * Envía JSON al mismo origen y conserva solo los errores públicos definidos por el servicio.
 * Entradas. Ruta relativa del servicio y opciones HTTP opcionales.
 * Salida. Promesa del cuerpo interpretado como T. Se rechaza ante un error HTTP o de conexión.
 */
export async function api<T>(route: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(route, { ...options, headers: { "Content-Type": "application/json", "X-Traza-Network": selectedNetwork, ...options.headers }, cache: "no-store" }); }
  catch { throw new ApplicationError("SERVICE_UNAVAILABLE", "No se pudo conectar con el servicio de la aplicación."); }
  const value = await response.json().catch(/* Clasifica una respuesta no JSON sin mostrar el cuerpo del servidor. Entradas. Ningún argumento utilizado. Salida. Objeto vacío como respuesta de respaldo. */ () => ({}));
  if (!response.ok) throw new ApplicationError(value.error?.code ?? "SERVICE_ERROR", value.error?.message ?? "El servicio no pudo completar la operación.");
  return value as T;
}

/**
 * Obtiene la configuración del despliegue real sin incorporar direcciones en los componentes.
 * Entradas. Red opcional, con la selección en memoria por defecto.
 * Salida. Promesa de la configuración pública del despliegue.
 */
export function getConfiguration(network = selectedNetwork) { return api<Configuration>("/api/config", { headers: { "X-Traza-Network": network } }); }

/**
 * Define la red de todos los clientes a partir de una sola configuración pública.
 * Entradas. Configuración pública con red, identificador de cadena y URL RPC de wallet.
 * Salida. Definición de cadena para los clientes viem.
 */
export function configuredChain(config: Configuration) {
  return defineChain({ id: Number(config.chainId), name: config.network === "amoy" ? "Polygon Amoy" : config.network, nativeCurrency: { name: config.network === "amoy" ? "POL" : "Ether de desarrollo", symbol: config.network === "amoy" ? "POL" : "ETH", decimals: 18 }, rpcUrls: { default: { http: [config.walletRpcUrl] } } });
}

/**
 * Crea un cliente de lectura que no solicita permisos a la wallet ni expone credenciales RPC.
 * Entradas. Configuración pública con red y ruta del proxy RPC.
 * Salida. Cliente público viem con transporte HTTP.
 */
export function publicClient(config: Configuration) {
  return createPublicClient({ chain: configuredChain(config), transport: http(new URL(config.rpcPath, window.location.origin).href, { timeout: 15_000, retryCount: 1, fetchOptions: { headers: { "X-Traza-Network": config.network } } }) });
}

/**
 * Estima la operación exacta y añade un 20 % de margen, sin superar el gas permitido por el bloque.
 * Entradas. Configuración, cuenta remitente, datos y destino opcional de la transacción.
 * Salida. Promesa del límite de gas estimado con margen, como BigInt.
 */
export async function estimateOperationGas(config: Configuration, account: Address, data: Hex, to?: Address) {
  const client = publicClient(config);
  const [estimate, block] = await Promise.all([client.estimateGas({ account, data, to, value: 0n }), client.getBlock({ blockTag: "latest" })]);
  if (estimate <= 0n || block.gasLimit <= 0n || estimate > block.gasLimit) throw new ApplicationError("GAS_LIMIT_EXCEEDED", "El gas necesario para esta operación supera el límite disponible en la red.");
  // La división redondea hacia arriba para conservar el margen también con cantidades que no sean múltiplos de cinco.
  const buffered = estimate + (estimate + 4n) / 5n;
  return buffered > block.gasLimit ? block.gasLimit : buffered;
}

/**
 * Exige un proveedor de wallet sin utilizar cuentas desbloqueadas del servidor para registrar contenido.
 * Entradas. Sin argumentos. Usa la sesión local o window.ethereum.
 * Salida. Proveedor EIP-1193 disponible.
 */
export function walletProvider(): WalletProvider {
  if (localProvider) return localProvider;
  if (!window.ethereum) throw new ApplicationError("WalletMissing");
  return window.ethereum;
}

/**
 * Solicita la cuenta y la cadena actuales al proveedor EIP-1193 conectado.
 * Entradas. Sin argumentos. Usa el proveedor EIP-1193 activo.
 * Salida. Promesa de la primera dirección autorizada y su cadena como cadena decimal.
 */
export async function connectWallet() {
  const provider = walletProvider();
  const accounts = await provider.request({ method: "eth_requestAccounts" }) as Address[];
  if (!accounts[0]) throw new ApplicationError("WalletDisconnected");
  const chainId = BigInt(await provider.request({ method: "eth_chainId" }) as string).toString();
  return { address: accounts[0], chainId };
}

/**
 * Valida la cuenta y la red justo antes de firmar o enviar una transacción.
 * Entradas. Configuración de red y dirección esperada opcional.
 * Salida. Promesa de la dirección validada y un cliente viem de wallet.
 */
export async function currentWallet(config: Configuration, expected?: Address) {
  const provider = walletProvider();
  const accounts = await provider.request({ method: "eth_accounts" }) as Address[];
  if (!accounts[0]) throw new ApplicationError("WalletDisconnected");
  if (expected && accounts[0].toLowerCase() !== expected.toLowerCase()) throw new ApplicationError("WrongRegistrant");
  if (BigInt(await provider.request({ method: "eth_chainId" }) as string).toString() !== config.chainId) throw new ApplicationError("WrongChain");
  return { address: accounts[0], client: createWalletClient({ account: accounts[0], chain: configuredChain(config), transport: custom(provider as EIP1193Provider) }) };
}

/**
 * Solicita cambiar de red o agregar la red configurada si la wallet todavía no la conoce.
 * Entradas. Configuración pública de la red de destino.
 * Salida. Promesa sin valor. Solicita a la wallet el cambio de cadena.
 */
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

/**
 * Firma un permiso de un solo uso sin transferir la clave de la wallet al servicio.
 * Entradas. Configuración, acción, ruta del servicio y cuerpo que se va a autorizar.
 * Salida. Promesa del resultado de la solicitud autorizada como T.
 */
export async function authorizedRequest<T>(config: Configuration, action: string, route: string, payload: unknown) {
  const wallet = await currentWallet(config);
  const challenge = await api<{ id: string; message: string }>("/api/challenges", { method: "POST", headers: { "X-Traza-Network": config.network }, body: JSON.stringify({ address: wallet.address, action, payload }) });
  const signature = await wallet.client.signMessage({ message: challenge.message });
  await currentWallet(config, wallet.address);
  return api<T>(route, { method: "POST", headers: { "X-Traza-Network": config.network }, body: JSON.stringify({ challengeId: challenge.id, signature, payload }) });
}

/**
 * Procesa los bytes exactos en un trabajador cancelable y comunica únicamente progreso real de lectura.
 * Entradas. Archivo, callback de progreso en bytes y señal de cancelación opcional.
 * Salida. Promesa de la huella Poseidon decimal.
 */
export function hashFile(file: File, onProgress: (processed: number, total: number) => void, signal?: AbortSignal): Promise<string> {
  return new Promise(/* Coordina el resultado y la cancelación de un trabajador independiente. Entradas. Funciones resolve y reject de la promesa de huella. Salida. Sin valor de retorno. Inicia el trabajador y registra sus manejadores. */ (resolve, reject) => {
    const worker = new Worker(new URL("./hash.worker.ts", import.meta.url), { type: "module" });
    /**
     * Libera el trabajador y su manejador de cancelación al finalizar la lectura.
     * Entradas. Sin argumentos. Usa el trabajador y la señal de cancelación de la operación.
     * Salida. Sin valor de retorno. Termina el trabajador y desregistra el manejador.
     */
    function cleanup() { worker.terminate(); signal?.removeEventListener("abort", cancel); }
    /**
     * Interrumpe el procesamiento al reemplazar o cancelar el archivo.
     * Entradas. Sin argumentos. Usa el trabajador y la promesa de la operación.
     * Salida. Sin valor de retorno. Limpia recursos y rechaza el cálculo con AbortError.
     */
    function cancel() { cleanup(); reject(new DOMException("Operación cancelada", "AbortError")); }
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener("abort", cancel, { once: true });
    /**
     * Traduce los mensajes del trabajador a progreso, huella o error público.
     * Entradas. Evento con mensaje de progreso, resultado o error del trabajador.
     * Salida. Sin valor de retorno. Notifica el avance o resuelve o rechaza el cálculo.
     */
    worker.onmessage = (event) => {
      if (event.data.type === "progress") onProgress(event.data.processed, event.data.total);
      else if (event.data.type === "result") { cleanup(); resolve(event.data.contentHash); }
      else { cleanup(); reject(new ApplicationError("HASH_FAILED", "No se pudo calcular la huella del archivo.")); }
    };
    /**
     * Clasifica fallas de inicialización o carga WASM del trabajador.
     * Entradas. Ningún argumento utilizado.
     * Salida. Sin valor de retorno. Limpia recursos y rechaza el cálculo con HASH_FAILED.
     */
    worker.onerror = () => { cleanup(); reject(new ApplicationError("HASH_FAILED", "No se pudo iniciar el procesamiento Poseidon.")); };
    worker.postMessage({ file });
  });
}

/**
 * Obtiene una prueba pública sin recibir firma EdDSA, identidad de fuente ni ruta Merkle en el navegador.
 * Entradas. Configuración, huella decimal, callback de etapas y señal opcional de cancelación.
 * Salida. Promesa del resultado público de la prueba.
 */
export async function generateRegistrationProof(config: Configuration, contentHash: string, onStage: (stage: Stage) => void, signal?: AbortSignal): Promise<ProofResult> {
  onStage("permission");
  const job = await authorizedRequest<{ jobId: string; jobToken: string }>(config, "proof", "/api/proofs", { contentHash });
  const route = "/api/proofs/" + job.jobId;
  const headers = { Authorization: "Bearer " + job.jobToken, "X-Traza-Network": config.network };
  /**
   * Cancela también el trabajo servidor sin guardar su token ni sus entradas en disco del navegador.
   * Entradas. Sin argumentos. Usa la ruta y el token del trabajo activo.
   * Salida. Sin valor de retorno. Solicita cancelar el trabajo remoto.
   */
  function cancel() { void api(route, { method: "DELETE", headers }).catch(/* La cancelación no reemplaza un resultado ya recibido. Entradas. Ningún argumento utilizado. Salida. undefined ante un error al solicitar la cancelación. */ () => undefined); }
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) { cancel(); throw new DOMException("Operación cancelada", "AbortError"); }
      const value = await api<{ stage: Stage | "error"; error?: { code: string; message: string }; result?: ProofResult }>(route, { headers, signal });
      if (value.error) throw new ApplicationError(value.error.code, value.error.message);
      if (value.stage !== "error") onStage(value.stage);
      if (value.result) return value.result;
      await new Promise(/* Espera entre consultas sin bloquear la interfaz. Entradas. Función resolve de la promesa. Salida. Sin valor útil. Programa resolve después de 200 ms. */ (resolve) => setTimeout(resolve, 200));
    }
  } finally { signal?.removeEventListener("abort", cancel); }
}

/**
 * Comprueba proveedor y código antes de cualquier lectura pública del registro.
 * Entradas. Configuración con red, cadena y dirección del registro.
 * Salida. Promesa de un cliente público conectado a la cadena y al contrato esperados.
 */
export async function registryClient(config: Configuration) {
  const client = publicClient(config);
  try {
    if (String(await client.getChainId()) !== config.chainId) throw new ApplicationError("WrongChain");
    const code = await client.getCode({ address: config.registryAddress });
    if (!code || code === "0x") throw new ApplicationError("ContractMissing");
    return client;
  } catch (error) { if (error instanceof ApplicationError) throw error; throw new ApplicationError("RPC_UNAVAILABLE"); }
}

/**
 * Consulta una huella sin conectar wallet ni crear otra prueba de conocimiento cero.
 * Entradas. Configuración y huella de contenido decimal.
 * Salida. Promesa del registro público con su indicador exists.
 */
export async function queryRegistry(config: Configuration, contentHash: string): Promise<ContentRecord> {
  const client = await registryClient(config);
  try { return await client.readContract({ address: config.registryAddress, abi: config.registryAbi, functionName: "getRecord", args: [BigInt(contentHash)] }) as ContentRecord; }
  catch { throw new ApplicationError("RPC_UNAVAILABLE"); }
}

/**
 * Envía una prueba con la wallet, espera el recibo y devuelve únicamente información pública de confirmación.
 * Entradas. Configuración, prueba pública y callback de etapas con hash de transacción opcional.
 * Salida. Promesa del recibo con hash, bloque, gas y latencia.
 */
export async function registerContent(config: Configuration, proof: ProofResult, onStage: (stage: Stage, transactionHash?: Hash) => void): Promise<PublicReceipt> {
  const expected = ("0x" + BigInt(proof.publicSignals[4]).toString(16).padStart(40, "0")) as Address;
  const wallet = await currentWallet(config, expected);
  if (proof.artifactId !== config.artifactId || proof.publicSignals[5] !== config.chainId || BigInt(proof.publicSignals[6]) !== BigInt(config.registryAddress)) throw new ApplicationError("InvalidProof");
  const client = await registryClient(config);
  const registry = getContract({ address: config.registryAddress, abi: config.registryAbi, client: { public: client, wallet: wallet.client } });
  const value = proof.solidity;
  const args = [value.pA.map(BigInt), value.pB.map(/* Convierte cada pareja manteniendo el orden exportado por snarkjs. Entradas. Par de coordenadas de pB. Salida. Par equivalente de BigInt en el mismo orden. */ (pair) => pair.map(BigInt)), value.pC.map(BigInt), value.publicSignals.map(BigInt)];
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

/**
 * Publica o deshabilita una raíz mediante una transacción de la wallet administradora.
 * Entradas. Configuración y raíz decimal opcional. Omitirla deshabilita la raíz.
 * Salida. Promesa del hash de la transacción confirmada.
 */
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

/**
 * Propone o acepta una transferencia administrativa en las dos etapas exigidas por el contrato.
 * Entradas. Configuración y cuenta propuesta opcional. Omitirla acepta la transferencia pendiente.
 * Salida. Promesa del hash de la transacción confirmada.
 */
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
