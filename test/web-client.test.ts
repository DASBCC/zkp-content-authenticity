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

/** Restablece las superficies globales sustituidas únicamente para una prueba unitaria. */
afterEach(() => { globalThis.fetch = originalFetch; selectNetwork("localhost"); Reflect.deleteProperty(globalThis, "window"); });

/** Comprueba que cada solicitud utilice la red elegida y no una selección anterior del navegador. */
test("el selector distingue las redes y envía el destino de servicio explícito", async () => {
  provider();
  let network;
  globalThis.fetch = /* Captura solo la cabecera pública de destino para este caso unitario. */ async (_input, options) => { network = new Headers(options?.headers).get("X-Traza-Network"); return new Response("{}", { status: 200 }); };
  selectNetwork("amoy");
  assert.equal(getSelectedNetwork(), "amoy");
  await api("/api/config");
  assert.equal(network, "amoy");
  selectNetwork("localhost");
  await api("/api/config");
  assert.equal(network, "localhost");
  assert.throws(() => selectNetwork("otra-red"));
});

/** Crea una wallet de ensayo que responde a métodos concretos para comprobar defensas del cliente. */
function provider(chain = "0x7a69", accounts = [ADDRESS]) {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ethereum: { request: /* Devuelve solo respuestas de los métodos esperados por cada caso unitario. */ async ({ method }: { method: string }) => method === "eth_chainId" ? chain : method === "personal_sign" ? "0x" + "11".repeat(65) : accounts }, location: { origin: "http://127.0.0.1:5173" } } });
}

/** Comprueba que la presentación abrevia identificadores sin cambiar sus valores canónicos originales. */
test("el formato conserva enteros largos y limita solamente su presentación", () => {
  assert.equal(short("1234"), "1234");
  const value = "1234567890123456789012345678901234567890";
  assert.equal(short(value, 4), "1234…7890");
  assert.equal(value.length, 40);
});

/** Distingue rechazo de wallet, errores de contrato y fallas técnicas sin mostrar contenidos privados. */
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

/** Comprueba margen, límites y contexto RPC antes de enviar una transacción desde la wallet. */
test("estima el gas de los datos exactos y acota el margen al límite del bloque", async () => {
  provider();
  let estimate = 500_001n;
  let blockLimit = 30_000_000n;
  const requests: { method: string; params: Record<string, string>[]; network: string | null }[] = [];
  globalThis.fetch = /* Responde exclusivamente a las dos consultas públicas utilizadas para estimar esta operación. */ async (_input, options) => {
    const request = JSON.parse(options?.body as string);
    requests.push({ ...request, network: new Headers(options?.headers).get("X-Traza-Network") });
    assert.ok(["eth_estimateGas", "eth_getBlockByNumber"].includes(request.method));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: request.method === "eth_estimateGas" ? "0x" + estimate.toString(16) : { number: "0x1", gasLimit: "0x" + blockLimit.toString(16), transactions: [] } }));
  };
  const target = { ...config, network: "amoy", chainId: "80002", rpcPath: "/rpc" };
  assert.equal(await estimateOperationGas(target, ADDRESS, "0x1234"), 600_002n);
  const transaction = requests.find(/* Localiza la simulación sin depender del orden de las consultas paralelas. */ (request) => request.method === "eth_estimateGas")!;
  assert.equal(transaction.network, "amoy");
  assert.equal(transaction.params[0].from.toLowerCase(), ADDRESS);
  assert.equal(transaction.params[0].data, "0x1234");
  assert.equal(transaction.params[0].to, undefined);
  assert.equal(transaction.params[0].value, "0x0");
  blockLimit = 550_000n;
  assert.equal(await estimateOperationGas(target, ADDRESS, "0xabcd", ADDRESS), blockLimit);
  assert.equal(requests.findLast(/* Busca la última simulación aunque el bloque se haya consultado antes. */ (request) => request.method === "eth_estimateGas")?.params[0].to, ADDRESS);
  estimate = blockLimit + 1n;
  await assert.rejects(estimateOperationGas(target, ADDRESS, "0x1234"), /gas necesario/);
  estimate = 0n;
  await assert.rejects(estimateOperationGas(target, ADDRESS, "0x1234"), /gas necesario/);
});

/** Comprueba que no se presuponga una wallet cuando el navegador no ofrece proveedor. */
test("la conexión exige una wallet y obtiene su cuenta y cadena reales", async () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  await assert.rejects(connectWallet(), /wallet EVM/);
  provider();
  assert.deepEqual(await connectWallet(), { address: ADDRESS, chainId: "31337" });
});

/** Impide firmar en otra cadena o con una cuenta que cambió después de preparar la prueba. */
test("la validación rechaza red equivocada, cuenta cambiada y wallet desconectada", async () => {
  provider("0x13882");
  await assert.rejects(currentWallet(config), /otra red/);
  provider();
  await assert.rejects(currentWallet(config, "0x2222222222222222222222222222222222222222"), /registrante/);
  provider("0x7a69", []);
  await assert.rejects(currentWallet(config), /Conecta tu wallet/);
});

/** Mantiene acción y cuerpo vinculados al permiso y solicita la firma únicamente a la wallet. */
test("el cliente de autorización firma el desafío y transmite solo los datos necesarios", async () => {
  provider();
  const requests: { route: string; value: Record<string, unknown> }[] = [];
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

/** Evita convertir una falla HTTP en una respuesta de contenido inexistente. */
test("los errores del servicio permanecen diferenciados de una consulta negativa", async () => {
  globalThis.fetch = /* Simula únicamente una indisponibilidad operativa para comprobar el manejo de errores. */ async () => new Response(JSON.stringify({ error: { code: "RPC_UNAVAILABLE", message: "Nodo no disponible" } }), { status: 503 });
  await assert.rejects(api("/api/config"), /Nodo no disponible/);
});
