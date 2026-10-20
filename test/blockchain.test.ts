/** Comprueba el flujo completo con Groth16 real, el registro EVM y los ataques de reutilización, copia y cambio de contexto. */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { after, test } from "node:test";
import { connectBlockchain, createRegistrationOperation, deployContracts, checkDeployment, measureVerifierGas, proofArguments, queryContent, queryFile, registerProof } from "../src/blockchain.ts";
import type { ProofArguments, PublicSignals } from "../src/blockchain.ts";
import { signContentAuthorization } from "../src/authorization.mjs";
import { derivePublicKey } from "../src/eddsa.mjs";
import { stringifyCrypto } from "../src/encoding.mjs";
import { calculateContentHash } from "../src/hashing.mjs";
import { privateKeyFromHex } from "../src/key-management.mjs";
import { buildAuthorizedSourcesTree, getSourceProof } from "../src/merkle.mjs";
import { generateNonce } from "../src/protocol.mjs";
import { createProofInputs, ensureZkArtifacts, generateProof } from "../src/zkp.mjs";
import { testSeed } from "./fixtures.mjs";

// Cada ejecución utiliza una cadena aislada; las semillas siguientes son datos públicos de ensayo.
const connection = await connectBlockchain("hardhatMainnet");
const { viem, networkHelpers } = connection;
const publicClient = await viem.getPublicClient();
const [owner, other] = await viem.getWalletClients();

/** Cierra únicamente la conexión creada para este archivo de pruebas. */
after(async () => { await connection.close(); });

/** Sustituye una señal pública conservando las coordenadas originales para probar su vinculación criptográfica. */
function changeSignal(args: ProofArguments, index: number, value: bigint): ProofArguments {
  const signals = [...args[3]];
  signals[index] = value;
  return [args[0], args[1], args[2], signals as unknown as PublicSignals];
}

/** Despliega ambos contratos reales y prepara pruebas válidas de distintos contextos sobre una instantánea reutilizable. */
async function deployFixture() {
  const seed = testSeed();
  const secondSeed = privateKeyFromHex("42".repeat(32));
  const attackerSeed = privateKeyFromHex("43".repeat(32));
  const publicKey = await derivePublicKey(seed);
  const secondKey = await derivePublicKey(secondSeed);
  const sources = [{ sourceId: 1n, publicKey }, { sourceId: 2n, publicKey: secondKey }];
  const tree = await buildAuthorizedSourcesTree(sources);
  const deployment = await deployContracts(connection, tree.root);
  const registry = await viem.getContractAt("ContentRegistry", deployment.registryAddress);
  const verifier = await viem.getContractAt("Groth16Verifier", deployment.verifierAddress);
  const otherRegistry = await viem.deployContract("ContentRegistry", [verifier.address]);
  await otherRegistry.write.setAuthorizedSourcesRoot([tree.root]);
  const hashStart = performance.now();
  const contentHash = await calculateContentHash("samples/prueba.txt");
  const hashingMs = performance.now() - hashStart;
  const operation = await createRegistrationOperation(connection, registry.address, 1n);

  /** Firma una autorización de ensayo y genera su prueba real contra la raíz y el contexto recibidos. */
  async function prove(hash: bigint, context = operation.context, nonce = generateNonce(), sourceId = 1n, sourceSeed = seed, sourceTree = tree) {
    const authorization = await signContentAuthorization({ contentHash: hash, protocolVersion: 1n, sourceId, nonce, context }, sourceSeed);
    const membership = await getSourceProof(sourceTree, sourceId);
    return generateProof(await createProofInputs(authorization, membership));
  }

  const proof = await prove(contentHash, operation.context, operation.nonce);
  const reused = await prove(contentHash + 1n, operation.context, operation.nonce);
  const wrongChain = await prove(contentHash + 2n, { ...operation.context, chainId: operation.context.chainId + 1n });
  const wrongRegistry = await prove(contentHash + 3n, { ...operation.context, registryAddress: otherRegistry.address });
  const attackerTree = await buildAuthorizedSourcesTree([{ sourceId: 3n, publicKey: await derivePublicKey(attackerSeed) }]);
  const unauthorized = await prove(contentHash + 4n, operation.context, generateNonce(), 3n, attackerSeed, attackerTree);
  const args = await proofArguments(proof.proof, proof.publicSignals);
  return { deployment, registry, verifier, contentHash, hashingMs, tree, sources, prove, proof, reused, wrongChain, wrongRegistry, unauthorized, args, secondSeed };
}

/** Verifica que un intento rechazado no consuma la autorización ni cree un registro. */
async function assertUnchanged(registry: Awaited<ReturnType<typeof deployFixture>>["registry"], args: ProofArguments) {
  assert.equal((await registry.read.getRecord([args[3][0]])).exists, false);
  assert.equal(await registry.read.usedNullifiers([args[3][3]]), false);
}

/** Ejecuta desde el archivo hasta una transacción confirmada y guarda métricas públicas de esta ejecución local. */
test("E2E: archivo, firma, Merkle, Groth16, verificador real, registro y consulta", async () => {
  const fixture = await networkHelpers.loadFixture(deployFixture);
  const { deployment, registry, verifier, proof, args, contentHash } = fixture;
  assert.equal((await checkDeployment(connection, deployment)).valid, true);
  assert.equal(await verifier.read.verifyProof(args), true);
  const measured = await measureVerifierGas(connection, deployment, proof);
  const registration = await registerProof(connection, deployment, proof);
  const receipt = await publicClient.getTransactionReceipt({ hash: registration.transactionHash });
  const events = await registry.getEvents.ContentRegistered({}, { fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber });
  assert.equal(events.length, 1);
  assert.equal(events[0].args.contentHash, contentHash);
  assert.equal(events[0].args.registrant?.toLowerCase(), owner.account.address.toLowerCase());
  const query = await queryFile(connection, registry.address, "samples/prueba.txt");
  assert.equal(query.record.exists, true);
  assert.equal(query.record.contentHash, contentHash);
  assert.equal(query.record.protocolVersion, 1n);
  assert.equal(query.record.registrant.toLowerCase(), owner.account.address.toLowerCase());
  assert.equal(query.record.registeredAt, (await publicClient.getBlock({ blockNumber: receipt.blockNumber })).timestamp);
  assert.equal(await registry.read.usedNullifiers([args[3][3]]), true);
  assert.equal((await queryContent(connection, registry.address, contentHash + 999n)).exists, false);
  const manifest = await ensureZkArtifacts();
  const report = { format: "content-authenticity-experiment-v1", runAt: new Date().toISOString(), network: deployment.network,
    chainId: deployment.chainId, ephemeral: true, artifactId: proof.artifactId, setup: manifest.setup,
    metrics: { ...manifest.metrics, hashingMs: fixture.hashingMs, ...proof.metrics, verifierGas: measured.verifierGas,
      verifierGasEstimate: registration.verifierGasEstimate, registrationGas: registration.registrationGas,
      proofAbiBytes: registration.proofAbiBytes, confirmationMs: registration.confirmationMs } };
  await mkdir("metrics/runs", { recursive: true });
  await writeFile("metrics/runs/e2e-local-" + Date.now() + ".json", stringifyCrypto(report) + "\n", { flag: "wx" });
});

/** Comprueba que el contenido registrado no se duplica y que la autorización no puede usarse con otra huella. */
test("rechaza contenido duplicado y un nullifier ya consumido para otro contenido", async () => {
  const { registry, proof, reused, args, deployment } = await networkHelpers.loadFixture(deployFixture);
  await registerProof(connection, deployment, proof);
  await viem.assertions.revertWithCustomError(registry.write.register(args), registry, "ContentAlreadyRegistered");
  const reusedArgs = await proofArguments(reused.proof, reused.publicSignals);
  assert.equal(reusedArgs[3][3], args[3][3]);
  await viem.assertions.revertWithCustomError(registry.write.register(reusedArgs), registry, "NullifierAlreadyUsed");
  assert.equal((await registry.read.getRecord([reusedArgs[3][0]])).exists, false);
});

/** Comprueba que copiar una prueba o sustituir su registrante no permite atribuirla a otra billetera. */
test("rechaza copia y front-running de una prueba por otro registrante", async () => {
  const { registry, args } = await networkHelpers.loadFixture(deployFixture);
  await viem.assertions.revertWithCustomError(registry.write.register(args, { account: other.account }), registry, "WrongRegistrant");
  const altered = changeSignal(args, 4, BigInt(other.account.address));
  await viem.assertions.revertWithCustomError(registry.write.register(altered, { account: other.account }), registry, "InvalidProof");
  await assertUnchanged(registry, args);
});

/** Comprueba que una prueba matemáticamente válida para otra cadena o contrato no sirve en este registro. */
test("rechaza pruebas reales de otra cadena o contrato, incluso si alteran sus señales públicas", async () => {
  const { registry, wrongChain, wrongRegistry } = await networkHelpers.loadFixture(deployFixture);
  const chainArgs = await proofArguments(wrongChain.proof, wrongChain.publicSignals);
  await viem.assertions.revertWithCustomError(registry.write.register(chainArgs), registry, "WrongChain");
  await viem.assertions.revertWithCustomError(registry.write.register(changeSignal(chainArgs, 5, 31337n)), registry, "InvalidProof");
  await assertUnchanged(registry, chainArgs);
  const contractArgs = await proofArguments(wrongRegistry.proof, wrongRegistry.publicSignals);
  await viem.assertions.revertWithCustomError(registry.write.register(contractArgs), registry, "WrongRegistry");
  await viem.assertions.revertWithCustomError(registry.write.register(changeSignal(contractArgs, 6, BigInt(registry.address))), registry, "InvalidProof");
  await assertUnchanged(registry, contractArgs);
});

/** Comprueba que una fuente que conoce su propia clave y raíz no obtiene autorización del administrador. */
test("rechaza una prueba válida de una fuente no autorizada y una raíz deshabilitada", async () => {
  const { registry, unauthorized, args } = await networkHelpers.loadFixture(deployFixture);
  const attackerArgs = await proofArguments(unauthorized.proof, unauthorized.publicSignals);
  await viem.assertions.revertWithCustomError(registry.write.register(attackerArgs), registry, "UnauthorizedRoot");
  await viem.assertions.revertWithCustomError(registry.write.register(changeSignal(attackerArgs, 2, args[3][2])), registry, "InvalidProof");
  await assertUnchanged(registry, attackerArgs);
  await registry.write.disableAuthorizedSourcesRoot();
  await viem.assertions.revertWithCustomError(registry.write.register(args), registry, "AuthorizationRootDisabled");
  await assertUnchanged(registry, args);
});

/** Comprueba la versión, el dominio y la vinculación de huella y nullifier sin modificar el estado al fallar. */
test("rechaza señales públicas y coordenadas alteradas sin consumir estado", async () => {
  const { registry, args } = await networkHelpers.loadFixture(deployFixture);
  await viem.assertions.revertWithCustomError(registry.write.register(changeSignal(args, 1, 2n)), registry, "UnsupportedProtocolVersion");
  await viem.assertions.revertWithCustomError(registry.write.register(changeSignal(args, 7, 0n)), registry, "InvalidProtocolDomain");
  await viem.assertions.revertWithCustomError(registry.write.register(changeSignal(args, 0, args[3][0] + 1n)), registry, "InvalidProof");
  await viem.assertions.revertWithCustomError(registry.write.register(changeSignal(args, 3, args[3][3] + 1n)), registry, "InvalidProof");
  const invalid: ProofArguments = [[0n, 0n], [[0n, 0n], [0n, 0n]], [0n, 0n], args[3]];
  await viem.assertions.revertWithCustomError(registry.write.register(invalid), registry, "InvalidProof");
  await assertUnchanged(registry, args);
});

/** Revoca una fuente, conserva el registro histórico y acepta una fuente restante mediante la nueva raíz. */
test("la revocación bloquea la raíz anterior, conserva el historial y permite nuevas pruebas autorizadas", async () => {
  const { registry, deployment, proof, reused, contentHash, sources, prove, secondSeed } = await networkHelpers.loadFixture(deployFixture);
  await registerProof(connection, deployment, proof);
  const historical = await registry.read.getRecord([contentHash]);
  const remainingTree = await buildAuthorizedSourcesTree([sources[1]]);
  await registry.write.setAuthorizedSourcesRoot([remainingTree.root]);
  const oldArgs = await proofArguments(reused.proof, reused.publicSignals);
  await viem.assertions.revertWithCustomError(registry.write.register(oldArgs), registry, "UnauthorizedRoot");
  assert.deepEqual(await registry.read.getRecord([contentHash]), historical);
  assert.equal((await registry.read.getRecord([oldArgs[3][0]])).exists, false);
  const operation = await createRegistrationOperation(connection, registry.address, 2n);
  const newProof = await prove(contentHash + 5n, operation.context, operation.nonce, 2n, secondSeed, remainingTree);
  await registerProof(connection, deployment, newProof);
  assert.equal((await registry.read.getRecord([contentHash + 5n])).exists, true);
});
