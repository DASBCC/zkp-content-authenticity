/** Comprueba errores públicos, permisos de wallet y coordinación del cliente sin sustituir los E2E reales. */
import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { ApplicationError, errorMessage, short } from "../web/src/errors.ts";
import { api, connectWallet, currentWallet, authorizedRequest, estimateOperationGas, selectNetwork, getSelectedNetwork } from "../web/src/services.ts";
import type { Configuration } from "../web/src/types.ts";

// Direcciones públicas de ensayo; los dobles unitarios no contienen claves privadas.
const ADDRESS = "0x1111111111111111111111111111111111111111";
const originalFetch = globalThis.fetch;
const config = { chainId: "31337", network: "localhost", walletRpcUrl: "http://127.0.0.1:8545" } as Configuration;

/**
 * Restablece las superficies globales sustituidas únicamente para una prueba unitaria.
 * Entradas. Sin argumentos. Usa fetch original y las variables globales simuladas.
 * Salida. Sin valor de retorno. Restablece la red, fetch y window.
 */
afterEach(() => { globalThis.fetch = originalFetch; selectNetwork("localhost"); Reflect.deleteProperty(globalThis, "window"); });

/**
 * Comprueba que cada solicitud utilice la red elegida y no una selección anterior del navegador.
 * Entradas. Sin argumentos. Usa un proveedor simulado y dos redes seleccionables.
 * Salida. Promesa sin valor. Comprueba la cabecera de cada red y el rechazo de una red inválida.
 */
test("el selector distingue las redes y envía el destino de servicio explícito", async () => {
  provider();
  let network;
  /**
   * Simula la API de configuración para observar el destino de la solicitud.
   * Entradas. URL ignorada y opciones con encabezados.
   * Salida. Promesa de una respuesta 200. También captura X-Traza-Network.
   */
  globalThis.fetch = /* Captura solo la cabecera pública de destino para este caso unitario. */ async (_input, options) => { network = new Headers(options?.headers).get("X-Traza-Network"); return new Response("{}", { status: 200 }); };
  selectNetwork("amoy");
  assert.equal(getSelectedNetwork(), "amoy");
  await api("/api/config");
  assert.equal(network, "amoy");
  selectNetwork("localhost");
  await api("/api/config");
  assert.equal(network, "localhost");
  assert.throws(/* Intenta seleccionar una red ajena al protocolo. Entradas. Ningún argumento utilizado. Salida. Devuelve el resultado de la selección si termina. El caso espera una excepción. */ () => selectNetwork("otra-red"));
});

/**
 * Crea una wallet de ensayo que responde a métodos concretos para comprobar defensas del cliente.
 * Entradas. Identificador hexadecimal de cadena y cuentas opcionales.
 * Salida. Sin valor de retorno. Instala un proveedor simulado en window.ethereum.
 */
function provider(chain = "0x7a69", accounts = [ADDRESS]) {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ethereum: { request: /* Responde a los métodos EIP-1193 usados por la prueba. Entradas. Objeto con el nombre del método EIP-1193. Salida. Promesa de la cadena, una firma simulada o las cuentas del proveedor. */ async ({ method }: { method: string }) => method === "eth_chainId" ? chain : method === "personal_sign" ? "0x" + "11".repeat(65) : accounts }, location: { origin: "http://127.0.0.1:5173" } } });
}

/**
 * Comprueba que la presentación abrevia identificadores sin cambiar sus valores canónicos originales.
 * Entradas. Sin argumentos. Usa identificadores de distintas longitudes.
 * Salida. Sin valor de retorno. Comprueba la abreviación y la conservación del texto original.
 */
test("el formato conserva enteros largos y limita solamente su presentación", () => {
  assert.equal(short("1234"), "1234");
  const value = "1234567890123456789012345678901234567890";
  assert.equal(short(value, 4), "1234…7890");
  assert.equal(value.length, 40);
});

/**
 * Distingue rechazo de wallet, errores de contrato y fallas técnicas sin mostrar contenidos privados.
 * Entradas. Sin argumentos. Usa errores simulados del contrato, la wallet y el RPC.
 * Salida. Sin valor de retorno. Comprueba los mensajes públicos resultantes.
 */
test("los errores separan rechazo, duplicado, replay, red y fallas operativas", () => {
  assert.match(errorMessage({ cause: { code: 4001 } }), /rechazada/);
  assert.match(errorMessage({ data: { errorName: "ContentAlreadyRegistered" } }), /ya tienen/);
  assert.match(errorMessage({ cause: { data: { errorName: "NullifierAlreadyUsed" } } }), /ya fue utilizada/);
  assert.match(errorMessage(new ApplicationError("RPC_UNAVAILABLE")), /blockchain/);
  assert.match(errorMessage({ cause: { data: { originalError: { message: "transaction gas limit too high (cap: 16777216)" } } } }), /límite de gas/);
  assert.match(errorMessage({ cause: { message: "transaction gas too high" } }), /límite de gas/);
  assert.match(errorMessage({ cause: { name: "FeeCapTooHighError" } }), /comisión/);
  assert.ok(!errorMessage(new Error("witness=secret" )).includes("secret"));
});

/**
 * Comprueba margen, límites y contexto RPC antes de enviar una transacción desde la wallet.
 * Entradas. Sin argumentos. Usa un nodo simulado, cuenta y datos de transacción.
 * Salida. Promesa sin valor. Comprueba el margen y los límites de gas.
 */
test("estima el gas de los datos exactos y acota el margen al límite del bloque", async () => {
  provider();
  let estimate = 500_001n;
  let blockLimit = 30_000_000n;
  const requests: { method: string; params: Record<string, string>[]; network: string | null }[] = [];
  /**
   * Simula el nodo para examinar la estimación de gas y el límite del bloque.
   * Entradas. URL ignorada y opciones con el cuerpo RPC.
   * Salida. Promesa de una respuesta JSON-RPC simulada. También captura la solicitud.
   */
  globalThis.fetch = /* Responde exclusivamente a las dos consultas públicas utilizadas para estimar esta operación. */ async (_input, options) => {
    const request = JSON.parse(options?.body as string);
    requests.push({ ...request, network: new Headers(options?.headers).get("X-Traza-Network") });
    assert.ok(["eth_estimateGas", "eth_getBlockByNumber"].includes(request.method));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: request.method === "eth_estimateGas" ? "0x" + estimate.toString(16) : { number: "0x1", gasLimit: "0x" + blockLimit.toString(16), transactions: [] } }));
  };
  const target = { ...config, network: "amoy", chainId: "80002", rpcPath: "/rpc" };
  assert.equal(await estimateOperationGas(target, ADDRESS, "0x1234"), 600_002n);
  const transaction = requests.find(/* Localiza la simulación sin depender del orden de las consultas paralelas. Entradas. Solicitud RPC capturada. Salida. true si su método es eth_estimateGas. */ (request) => request.method === "eth_estimateGas")!;
  assert.equal(transaction.network, "amoy");
  assert.equal(transaction.params[0].from.toLowerCase(), ADDRESS);
  assert.equal(transaction.params[0].data, "0x1234");
  assert.equal(transaction.params[0].to, undefined);
  assert.equal(transaction.params[0].value, "0x0");
  blockLimit = 550_000n;
  assert.equal(await estimateOperationGas(target, ADDRESS, "0xabcd", ADDRESS), blockLimit);
  assert.equal(requests.findLast(/* Busca la última simulación aunque el bloque se haya consultado antes. Entradas. Solicitud RPC capturada. Salida. true si su método es eth_estimateGas. */ (request) => request.method === "eth_estimateGas")?.params[0].to, ADDRESS);
  estimate = blockLimit + 1n;
  await assert.rejects(estimateOperationGas(target, ADDRESS, "0x1234"), /gas necesario/);
  estimate = 0n;
  await assert.rejects(estimateOperationGas(target, ADDRESS, "0x1234"), /gas necesario/);
});

/**
 * Comprueba que no se presuponga una wallet cuando el navegador no ofrece proveedor.
 * Entradas. Sin argumentos. Usa un navegador con y sin proveedor simulado.
 * Salida. Promesa sin valor. Comprueba el error y los datos devueltos al conectar.
 */
test("la conexión exige una wallet y obtiene su cuenta y cadena reales", async () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  await assert.rejects(connectWallet(), /wallet EVM/);
  provider();
  assert.deepEqual(await connectWallet(), { address: ADDRESS, chainId: "31337" });
});

/**
 * Impide firmar en otra cadena o con una cuenta que cambió después de preparar la prueba.
 * Entradas. Sin argumentos. Usa variantes de cadena y cuenta del proveedor simulado.
 * Salida. Promesa sin valor. Comprueba los errores de cadena, cuenta y desconexión.
 */
test("la validación rechaza red equivocada, cuenta cambiada y wallet desconectada", async () => {
  provider("0x13882");
  await assert.rejects(currentWallet(config), /otra red/);
  provider();
  await assert.rejects(currentWallet(config, "0x2222222222222222222222222222222222222222"), /registrante/);
  provider("0x7a69", []);
  await assert.rejects(currentWallet(config), /Conecta tu wallet/);
});

/**
 * Mantiene acción y cuerpo vinculados al permiso y solicita la firma únicamente a la wallet.
 * Entradas. Sin argumentos. Usa una wallet y respuestas HTTP simuladas.
 * Salida. Promesa sin valor. Comprueba el cuerpo del desafío y de la acción firmada.
 */
test("el cliente de autorización firma el desafío y transmite solo los datos necesarios", async () => {
  provider();
  const requests: { route: string; value: Record<string, unknown> }[] = [];
  /**
   * Captura las solicitudes de autorización para comprobar el intercambio de datos.
   * Entradas. URL y opciones con el cuerpo HTTP.
   * Salida. Promesa de la respuesta simulada del desafío o de la acción autorizada.
   */
  globalThis.fetch = /* Registra los cuerpos públicos para revisar el contrato del cliente HTTP. */ async (input, options) => {
    requests.push({ route: String(input), value: JSON.parse(options?.body as string) });
    return new Response(JSON.stringify(requests.length === 1 ? { id: "permiso", message: "Mensaje de ensayo" } : { jobId: "trabajo", jobToken: "capacidad" }), { status: 200 });
  };
  const result = await authorizedRequest(config, "proof", "/api/proofs", { contentHash: "42" });
  assert.deepEqual(result, { jobId: "trabajo", jobToken: "capacidad" });
  assert.deepEqual(requests[0].value.payload, { contentHash: "42" });
  assert.deepEqual(requests[1].value.payload, { contentHash: "42" });
  assert.equal(requests[1].value.challengeId, "permiso");
  assert.equal(Object.hasOwn(requests[1].value, "sourceId"), false);
});

/**
 * Evita convertir una falla HTTP en una respuesta de contenido inexistente.
 * Entradas. Sin argumentos. Usa un servicio simulado que devuelve 503.
 * Salida. Promesa sin valor. Comprueba que se propaga el error público.
 */
test("los errores del servicio permanecen diferenciados de una consulta negativa", async () => {
  /**
   * Simula un fallo operativo del servicio.
   * Entradas. Ningún argumento utilizado.
   * Salida. Promesa de una respuesta JSON 503 con RPC_UNAVAILABLE.
   */
  globalThis.fetch = /* Simula únicamente una indisponibilidad operativa para comprobar el manejo de errores. */ async () => new Response(JSON.stringify({ error: { code: "RPC_UNAVAILABLE", message: "Nodo no disponible" } }), { status: 503 });
  await assert.rejects(api("/api/config"), /Nodo no disponible/);
});
