/** Verifica permisos, privacidad y operaciones HTTP con firmas EVM, Groth16 y contratos reales. */
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { connectBlockchain, deployContracts, proofArguments, queryContent, registerProof } from "../src/blockchain.ts";
import { createApplication } from "../server/app.ts";
import type { WebRuntime } from "../server/app.ts";
import { derivePublicKey } from "../src/eddsa.mjs";
import { savePrivateKey } from "../src/key-management.mjs";
import { stringifyCrypto } from "../src/encoding.mjs";
import { buildAuthorizedSourcesTree } from "../src/merkle.mjs";
import { testSeed, temporaryDirectory } from "./fixtures.mjs";

const connection = await connectBlockchain("hardhatMainnet");
const [owner, other] = await connection.viem.getWalletClients();
let app: Awaited<ReturnType<typeof createApplication>>;
const server = createServer(/* Atiende únicamente la instancia de ensayo de esta aplicación. Entradas. Solicitud y respuesta HTTP de prueba. Salida. Promesa sin valor. Atiende la aplicación o devuelve 404. */ async (request, response) => { if (!app || !await app.handle(request, response)) { response.writeHead(404); response.end(); } });
let origin: string;
let deployment: Awaited<ReturnType<typeof deployContracts>>;
let publicProof: { artifactId: string; proof: unknown; publicSignals: string[] };
let job: { jobId: string; jobToken: string };
let sourcesFile: string;
let sources: unknown[];
let runtime: WebRuntime;

/**
 * Prepara una fuente pública de ensayo y un servidor aislado conectado a contratos reales.
 * Entradas. Sin argumentos. Usa el nodo, el servidor y la wallet de ensayo.
 * Salida. Promesa sin valor. Prepara la fuente, el registro y la API de la suite.
 */
before(async () => {
  const directory = await temporaryDirectory("web-service-");
  const seed = testSeed();
  const sourceKeyFile = path.join(directory, "source-private.json");
  sourcesFile = path.join(directory, "sources.json");
  await savePrivateKey(sourceKeyFile, seed);
  sources = [{ sourceId: "1", publicKey: await derivePublicKey(seed) }];
  await writeFile(sourcesFile, stringifyCrypto(sources));
  const tree = await buildAuthorizedSourcesTree(sources);
  deployment = await deployContracts(connection, tree.root);
  await new Promise<void>(/* Obtiene un puerto libre reservado solo para este servidor. Entradas. Función resolve de la promesa de escucha. Salida. Devuelve el servidor. Resuelve la promesa cuando el puerto está abierto. */ (resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  runtime = { deployment, runtimeFile: path.join(directory, "runtime.json"), experimental: false, signingEnabled: true,
    allowedRegistrants: [owner.account.address], sourceId: "1", sourceKeyFile, sourcesFile, sourceKeys: { "1": sourceKeyFile }, walletRpcUrl: "http://127.0.0.1:8545" };
  app = await createApplication(connection, runtime, origin);
});

/**
 * Cierra los trabajos, el servidor y la cadena exclusiva del archivo.
 * Entradas. Sin argumentos. Usa la aplicación, servidor y conexión de la suite.
 * Salida. Promesa sin valor. Libera los recursos del ensayo.
 */
after(async () => { await app?.close(); server.closeAllConnections(); await new Promise<void>(/* Espera la liberación del puerto reservado. Entradas. Función resolve de la promesa de cierre. Salida. Devuelve el servidor. Resuelve la promesa cuando termina el cierre. */ (resolve) => server.close(/* Completa la espera al liberar el servidor de prueba. Entradas. Ningún argumento utilizado. Salida. Sin valor de retorno. Resuelve la promesa de cierre. */ () => resolve())); await connection.close(); });

/**
 * Envía una solicitud del mismo origen y devuelve su estado y JSON público.
 * Entradas. Ruta, cuerpo opcional y encabezados adicionales.
 * Salida. Promesa de un objeto con estado HTTP y cuerpo JSON.
 */
async function request(route: string, value?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(origin + route, { method: value === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", Origin: origin, ...headers }, ...(value === undefined ? {} : { body: stringifyCrypto(value) }) });
  return { status: response.status, value: await response.json() };
}

/**
 * Firma una solicitud con una wallet real del nodo y el mensaje exacto emitido por el servicio.
 * Entradas. Acción, cuerpo y wallet de ensayo, con el propietario por defecto.
 * Salida. Promesa del cuerpo autenticado con identificador, firma y datos.
 */
async function signed(action: string, payload: unknown, wallet = owner) {
  const challenge = await request("/api/challenges", { address: wallet.account.address, action, payload });
  assert.equal(challenge.status, 201);
  return { challengeId: challenge.value.id, signature: await wallet.signMessage({ message: challenge.value.message }), payload };
}

/**
 * Exige una configuración pública vinculada a contratos sin exponer identidades o claves de fuente.
 * Entradas. Sin argumentos. Usa la configuración pública de la aplicación de ensayo.
 * Salida. Promesa sin valor. Comprueba direcciones y ausencia de datos privados.
 */
test("la configuración publica contratos reales y mantiene privados los datos de fuente", async () => {
  const result = await request("/api/config");
  assert.equal(result.status, 200);
  assert.equal(result.value.deploymentReady, true);
  assert.equal(result.value.registryAddress, deployment.registryAddress);
  assert.equal(result.value.localWalletAvailable, false);
  for (const name of ["sourceId", "sourceKeyFile", "sourcesFile", "sourceKeys", "seed", "allowedRegistrants"]) assert.equal(Object.hasOwn(result.value, name), false);
});

/**
 * Impide firmar desde una cuenta ajena, administrar sin rol y acceder desde otro origen.
 * Entradas. Sin argumentos. Usa cuentas, permisos y orígenes de prueba.
 * Salida. Promesa sin valor. Comprueba los códigos de rechazo de la API.
 */
test("rechaza cuentas sin permiso, administración ajena, orígenes externos y RPC de escritura", async () => {
  assert.equal((await request("/api/challenges", { address: other.account.address, action: "proof", payload: { contentHash: "11" } })).status, 403);
  assert.equal((await request("/api/challenges", { address: other.account.address, action: "admin-sources", payload: {} })).status, 403);
  assert.equal((await request("/api/challenges", { address: owner.account.address, action: "proof", payload: { contentHash: "11" } }, { Origin: "https://example.com" })).status, 403);
  assert.equal((await request("/rpc", { jsonrpc: "2.0", method: "eth_sendTransaction", params: [], id: 1 })).status, 403);
  assert.equal((await request("/api/local-wallet/connect", { experimental: true })).status, 403);
  const removedImport = await request("/api/admin/prepare", { sources: [] });
  assert.equal(removedImport.status, 404);
  assert.equal(removedImport.value.error.code, "NOT_FOUND");
  const removedPermission = await request("/api/challenges", { address: owner.account.address, action: "admin-prepare", payload: { sources: [] } });
  assert.equal(removedPermission.status, 400);
  assert.equal(removedPermission.value.error.code, "BAD_REQUEST");
});

/**
 * Exige firma auténtica y consumo único del permiso, ligado al hash autorizado.
 * Entradas. Sin argumentos. Usa desafíos y firmas de ensayo.
 * Salida. Promesa sin valor. Comprueba el rechazo de firma inválida, cambios y replay.
 */
test("rechaza firma falsa, alteración del cuerpo y replay del desafío", async () => {
  const fake = await signed("proof", { contentHash: "21" });
  fake.signature = await other.signMessage({ message: "Otro mensaje" });
  assert.equal((await request("/api/proofs", fake)).status, 401);
  const permission = await signed("proof", { contentHash: "22" });
  assert.equal((await request("/api/proofs", { ...permission, payload: { contentHash: "23" } })).status, 401);
  assert.equal((await request("/api/proofs", permission)).status, 401);
});

/**
 * Produce Groth16 en el trabajador de confianza y registra su resultado real en el contrato.
 * Entradas. Sin argumentos. Usa la cuenta autorizada y un trabajo real del prover.
 * Salida. Promesa sin valor. Comprueba las etapas, la prueba pública y el registro.
 */
test("el servicio autoriza, genera y verifica Groth16 sin entregar su testigo al cliente", async () => {
  const permission = await signed("proof", { contentHash: "31" });
  const created = await request("/api/proofs", permission);
  assert.equal(created.status, 202);
  job = created.value;
  assert.equal((await request("/api/proofs/" + job.jobId)).status, 404);
  assert.equal((await request("/api/proofs", permission)).status, 401);
  let result;
  for (let count = 0; count < 150; count++) {
    result = await request("/api/proofs/" + job.jobId, undefined, { Authorization: "Bearer " + job.jobToken });
    assert.equal(result.status, 200);
    if (result.value.stage === "ready" || result.value.error) break;
    await new Promise(/* Espera etapas reales del trabajador sin sustituir su cálculo. Entradas. Función resolve de la promesa. Salida. Sin valor útil. Programa una pausa antes de consultar el trabajo. */ (resolve) => setTimeout(resolve, 100));
  }
  assert.equal(result!.value.stage, "ready", stringifyCrypto(result!.value.error));
  assert.deepEqual(result!.value.history, ["authorizing", "authorized", "witness", "proving", "verifying", "ready"]);
  publicProof = result!.value.result;
  assert.equal(publicProof.publicSignals.length, 8);
  assert.equal(publicProof.publicSignals[0], "31");
  for (const name of ["inputs", "witness", "authorization", "membership", "sourceId", "nonce", "seed"]) assert.equal(Object.hasOwn(publicProof, name), false);
  await registerProof(connection, deployment, publicProof);
  assert.equal((await queryContent(connection, deployment.registryAddress, "31")).exists, true);
  const registry = await connection.viem.getContractAt("ContentRegistry", deployment.registryAddress);
  await connection.viem.assertions.revertWithCustomError(registry.write.register(await proofArguments(publicProof.proof, publicProof.publicSignals)), registry, "ContentAlreadyRegistered");
});

/**
 * Rechaza un duplicado en la frontera del servicio antes de generar otra autorización.
 * Entradas. Sin argumentos. Usa un contenido registrado y un cuerpo con campos extra.
 * Salida. Promesa sin valor. Comprueba que la API rechaza ambas solicitudes.
 */
test("la API rechaza contenido ya registrado y los permisos no aceptan propiedades extra", async () => {
  const duplicate = await request("/api/proofs", await signed("proof", { contentHash: "31" }));
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.value.error.code, "DUPLICATE_CONTENT");
  const malformed = await request("/api/proofs", await signed("proof", { contentHash: "32", nonce: "5" }));
  assert.equal(malformed.status, 400);
});

/**
 * Comprueba que posteriores cambios del conjunto no restauren por accidente una clave ya rotada.
 * Entradas. Sin argumentos. Usa el conjunto actual y la cuenta administradora.
 * Salida. Promesa sin valor. Comprueba que la clave rotada permite generar una prueba tras otra alta.
 */
test("la rotación conserva su nueva clave después de incorporar otra fuente", async () => {
  const registry = await connection.viem.getContractAt("ContentRegistry", deployment.registryAddress);
  for (const change of [{ kind: "rotate", sourceId: "1" }, { kind: "create", sourceId: "2" }]) {
    const plan = await request("/api/admin/change", await signed("admin-change", change));
    assert.equal(plan.status, 200);
    await registry.write.setAuthorizedSourcesRoot([BigInt(plan.value.root)]);
    assert.equal((await request("/api/admin/commit", await signed("admin-commit", { planId: plan.value.planId }))).status, 200);
  }
  const created = await request("/api/proofs", await signed("proof", { contentHash: "38" }));
  assert.equal(created.status, 202);
  let result;
  for (let count = 0; count < 150; count++) {
    result = await request("/api/proofs/" + created.value.jobId, undefined, { Authorization: "Bearer " + created.value.jobToken });
    if (result.value.stage === "ready" || result.value.error) break;
    await new Promise(/* Espera una prueba real con la nueva clave y la raíz actualizada. Entradas. Función resolve de la promesa. Salida. Sin valor útil. Programa una pausa antes de volver a consultar la prueba. */ (resolve) => setTimeout(resolve, 100));
  }
  assert.equal(result!.value.stage, "ready", stringifyCrypto(result!.value.error));
  await registerProof(connection, deployment, result!.value.result);
  assert.equal((await queryContent(connection, deployment.registryAddress, "38")).exists, true);
});

/**
 * Exige confirmar la raíz, conserva el historial y permite crear otra fuente tras revocar todas.
 * Entradas. Sin argumentos. Usa un plan administrativo y transacciones de ensayo.
 * Salida. Promesa sin valor. Comprueba que se exige la raíz confirmada en cadena.
 */
test("la administración requiere confirmación real de la nueva raíz antes de guardar el conjunto", async () => {
  const registry = await connection.viem.getContractAt("ContentRegistry", deployment.registryAddress);
  for (const sourceId of ["2", "1"]) {
    const prepared = await request("/api/admin/change", await signed("admin-change", { kind: "revoke", sourceId }));
    assert.equal(prepared.status, 200);
    const payload = { planId: prepared.value.planId };
    assert.equal((await request("/api/admin/commit", await signed("admin-commit", payload))).status, 409);
    await registry.write.setAuthorizedSourcesRoot([BigInt(prepared.value.root)]);
    assert.equal((await request("/api/admin/commit", await signed("admin-commit", payload))).status, 200);
  }
  assert.equal((await queryContent(connection, deployment.registryAddress, "31")).exists, true);
  assert.equal((await request("/api/proofs", await signed("proof", { contentHash: "34" }))).value.error.code, "SOURCE_UNAVAILABLE");

  const invalid = await request("/api/admin/change", await signed("admin-change", { kind: "create", sourceId: "02" }));
  assert.equal(invalid.status, 400);
  assert.equal(invalid.value.error.code, "INVALID_SOURCE_ID");
  const replacement = await request("/api/admin/change", await signed("admin-change", { kind: "create", sourceId: " 2 " }));
  assert.equal(replacement.status, 200);
  assert.equal(replacement.value.count, 1);
  await registry.write.setAuthorizedSourcesRoot([BigInt(replacement.value.root)]);
  assert.equal((await request("/api/admin/commit", await signed("admin-commit", { planId: replacement.value.planId }))).status, 200);
  const current = await request("/api/admin/sources", await signed("admin-sources", {}));
  assert.deepEqual(current.value.sources.map((source: { sourceId: string }) => source.sourceId), ["2"]);
});

/**
 * Permite al administrador suspender explícitamente la emisión y bloquea solicitudes posteriores.
 * Entradas. Sin argumentos. Usa la wallet administradora y una política de prueba.
 * Salida. Promesa sin valor. Comprueba la persistencia y aplicación de la política.
 */
test("la política de emisión es administrable y se aplica en el servidor", async () => {
  const saved = await request("/api/admin/policy", await signed("admin-policy", { allowedRegistrants: [owner.account.address], signingEnabled: false }));
  assert.equal(saved.status, 200);
  const blocked = await request("/api/challenges", { address: owner.account.address, action: "proof", payload: { contentHash: "35" } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.value.error.code, "SIGNING_DISABLED");
  const originalKey = runtime.sourceKeyFile;
  runtime.sourceKeyFile = "";
  try {
    const unsafeStorage = await request("/api/admin/change", await signed("admin-change", { kind: "create", sourceId: "5" }));
    assert.equal(unsafeStorage.status, 409);
    assert.equal(unsafeStorage.value.error.code, "KEY_STORAGE_UNAVAILABLE");
  } finally { runtime.sourceKeyFile = originalKey; }
});

/**
 * Verifica que la adopción exija contratos exactos, recibos auténticos y una raíz confirmada por el propietario.
 * Entradas. Sin argumentos. Usa un plan, recibos de prueba y la wallet real del nodo.
 * Salida. Promesa sin valor. Comprueba el rechazo de referencias inválidas y la adopción del despliegue válido.
 */
test("el despliegue de wallet solo adopta contratos reales y recibos del contexto autorizado", async () => {
  const prepared = await request("/api/deployment/prepare", await signed("wallet-deploy", { developmentSource: true }));
  assert.equal(prepared.status, 200);
  assert.equal(Object.hasOwn(prepared.value, "sourceKeyFile"), false);
  assert.equal(Object.hasOwn(prepared.value, "seed"), false);
  const plan = prepared.value;
  assert.equal((await request("/api/challenges", { address: other.account.address, action: "wallet-deploy", payload: { developmentSource: true } })).status, 403);
  const client = await connection.viem.getPublicClient();
  const wrong = await connection.viem.sendDeploymentTransaction("Groth16Verifier", [], { client: { public: client, wallet: other } });
  await client.waitForTransactionReceipt({ hash: wrong.deploymentTransaction.hash });
  const wrongProgress = await request("/api/deployment/progress", { planId: plan.planId, planToken: plan.planToken, kind: "verifier", transactionHash: wrong.deploymentTransaction.hash });
  assert.equal(wrongProgress.status, 409);
  const verifier = await connection.viem.sendDeploymentTransaction("Groth16Verifier");
  await client.waitForTransactionReceipt({ hash: verifier.deploymentTransaction.hash });
  const registry = await connection.viem.sendDeploymentTransaction("ContentRegistry", [verifier.contract.address]);
  await client.waitForTransactionReceipt({ hash: registry.deploymentTransaction.hash });
  const rootHash = await registry.contract.write.setAuthorizedSourcesRoot([BigInt(plan.root)]);
  await client.waitForTransactionReceipt({ hash: rootHash });
  const payload = { planId: plan.planId, planToken: plan.planToken, verifierTransaction: verifier.deploymentTransaction.hash,
    registryTransaction: registry.deploymentTransaction.hash, rootTransaction: rootHash };
  const rejected = await request("/api/deployment/commit", await signed("wallet-deploy", { ...payload, rootTransaction: verifier.deploymentTransaction.hash }));
  assert.equal(rejected.status, 409);
  assert.equal((await request("/api/config")).value.registryAddress, deployment.registryAddress);
  const accepted = await request("/api/deployment/commit", await signed("wallet-deploy", payload));
  assert.equal(accepted.status, 200);
  assert.equal((await request("/api/config")).value.registryAddress.toLowerCase(), registry.contract.address.toLowerCase());
});
