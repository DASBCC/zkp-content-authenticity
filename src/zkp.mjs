/** Compila el circuito, prepara Groth16 y genera pruebas reales con artefactos versionados e íntegros. */

import fs from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { CircomRunner, bindings } from "circom2";
import { curves, groth16, powersOfTau, r1cs, wtns, zKey } from "snarkjs";
import { normalizeAuthorizationPackage } from "./authorization.mjs";
import { verifyAuthorizationSignature } from "./eddsa.mjs";
import { exactKeys, parseField, stringifyCrypto } from "./encoding.mjs";
import { verifySourceProof } from "./merkle.mjs";
import { calculateNullifier, MERKLE_DEPTH, NONCE_BITS, PROTOCOL_DOMAIN, PROTOCOL_VERSION, PUBLIC_SIGNAL_NAMES } from "./protocol.mjs";

// La cola evita cerrar una curva mientras otra operación del mismo proceso todavía la utiliza.
let curveQueue = Promise.resolve();
// Formato de manifiesto y versiones cuyas APIs fueron comprobadas durante esta implementación.
const MANIFEST_FORMAT = "content-authenticity-groth16-v1";
const SUPPORTED_VERSIONS = { circom2: "0.2.23", circomlib: "2.0.5", circomlibjs: "0.1.7", snarkjs: "0.7.6" };
// Nombres privados admitidos por el circuito; se excluyen secretos y propiedades auxiliares de los paquetes.
const PRIVATE_INPUT_NAMES = ["sourceId", "nonce", "publicKeyX", "publicKeyY", "R8x", "R8y", "S", "merklePathElements", "merklePathIndices"];
const require = createRequire(import.meta.url);

/** Determina las rutas de los artefactos sin depender de una red blockchain concreta. */
export function artifactPaths(options = {}) {
  const root = path.resolve(options.artifactsDir ?? ".zk-artifacts/v1");
  return {
    root, sourceCircuit: path.resolve("circuits/content-authenticity.circom"),
    entry: path.join(root, "main.circom"), r1cs: path.join(root, "main.r1cs"),
    wasm: path.join(root, "main_js/main.wasm"), sym: path.join(root, "main.sym"),
    ptau: path.join(root, "powersOfTau_final.ptau"), zkey: path.join(root, "circuit_final.zkey"),
    verificationKey: path.join(root, "verification_key.json"),
    verifier: path.resolve(options.verifierPath ?? "contracts/Groth16Verifier.sol"),
    manifest: path.join(root, "manifest.json"), compilation: path.join(root, "compilation.json"),
  };
}

/** Encuentra la raíz de un paquete instalado, incluso si su entrada está dentro de build/. */
function packageRoot(name) {
  let directory = path.dirname(require.resolve(name));
  while (true) {
    const metadata = path.join(directory, "package.json");
    if (fs.existsSync(metadata) && JSON.parse(fs.readFileSync(metadata, "utf8")).name === name) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`No se encontró el paquete ${name}`);
    directory = parent;
  }
}

/** Registra las versiones instaladas y rechaza herramientas con APIs no comprobadas. */
async function installedVersions() {
  const result = {};
  for (const [name, expected] of Object.entries(SUPPORTED_VERSIONS)) {
    const metadata = JSON.parse(await readFile(path.join(packageRoot(name), "package.json"), "utf8"));
    if (metadata.version !== expected) throw new Error(`Versión no comprobada de ${name}: ${metadata.version}; se requiere ${expected}`);
    result[name] = metadata.version;
  }
  result.circomCompiler = "2.2.3";
  return result;
}

/** Calcula SHA-256 para identificar artefactos; la huella multimedia del protocolo sigue siendo Poseidon. */
async function fileHash(filename) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

/** Identifica también los circuitos de circomlib que intervienen en la compilación. */
async function circuitLibraryHash() {
  const root = path.join(packageRoot("circomlib"), "circuits");
  const files = [];
  /** Recorre los archivos de circuitos sin incluir paquetes ni directorios ajenos. */
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.name.endsWith(".circom")) files.push(filename);
    }
  }
  await visit(root);
  files.sort();
  const hash = createHash("sha256");
  for (const filename of files) hash.update(path.relative(root, filename).replaceAll("\\", "/") + ":" + await fileHash(filename) + "\n");
  return hash.digest("hex");
}

/** Describe los parámetros públicos que deben coincidir entre JavaScript, Circom y Solidity. */
function protocolParameters() {
  return {
    protocolVersion: PROTOCOL_VERSION.toString(), protocolDomain: PROTOCOL_DOMAIN.toString(),
    merkleDepth: MERKLE_DEPTH, nonceBits: NONCE_BITS, publicSignals: [...PUBLIC_SIGNAL_NAMES],
  };
}

/** Escribe JSON de forma atómica para no dejar un manifiesto parcialmente actualizado. */
async function writeJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = filename + "." + randomUUID() + ".tmp";
  await writeFile(temporary, stringifyCrypto(value) + "\n", { mode: 0o600 });
  await rename(temporary, filename);
}

/** Ejecuta una operación criptográfica y cierra los trabajadores de BN128 al terminar. */
function withCurve(operation) {
  /** Reserva la curva compartida solamente durante esta tarea de la cola. */
  async function execute() {
    const curve = await curves.getCurveFromName("bn128");
    try { return await operation(curve); }
    finally { await curve.terminate(); }
  }
  const pending = curveQueue.then(execute, execute);
  curveQueue = pending.catch(/* Mantiene utilizable la cola después de un error. */ () => undefined);
  return pending;
}

/** Genera la instancia principal con el orden público y los parámetros centralizados del protocolo. */
function circuitEntry() {
  return "pragma circom 2.2.0;\ninclude \"circuits/content-authenticity.circom\";\n" +
    "component main {public [" + PUBLIC_SIGNAL_NAMES.join(", ") + "]} = ContentAuthenticity(" +
    MERKLE_DEPTH + ", " + PROTOCOL_VERSION + ", " + PROTOCOL_DOMAIN + ");\n";
}

/** Compila Circom a R1CS/WASM y comprueba que no se hayan publicado señales privadas por accidente. */
export async function compileCircuit(options = {}) {
  const paths = artifactPaths(options);
  const relative = path.relative(process.cwd(), paths.root);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Los artefactos de compilación deben estar dentro del proyecto");
  await installedVersions();
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.entry, circuitEntry());
  const output = [];
  const nativeFs = {
    ...fs,
    /** Captura la salida del compilador sin mezclarla con los resultados JSON de los comandos. */
    writeSync(fd, buffer, offset, length, position) {
      if (fd === 1 || fd === 2) {
        const start = offset ?? 0;
        const count = length ?? buffer.byteLength;
        output.push(Buffer.from(buffer).subarray(start, start + count).toString("utf8"));
        return count;
      }
      return fs.writeSync(fd, buffer, offset, length, position);
    },
  };
  const runner = new CircomRunner({
    args: [path.relative(process.cwd(), paths.entry).replaceAll("\\", "/"), "--r1cs", "--wasm", "--sym", "-l", ".", "-l", "node_modules", "-o", relative.replaceAll("\\", "/") || "."],
    env: {}, preopens: { ".": process.cwd() }, bindings: { ...bindings, fs: nativeFs, path },
  });
  const start = performance.now();
  try { await runner.execute(await readFile(require.resolve("circom2/circom.wasm"))); }
  catch (error) { throw new Error("Falló la compilación Circom: " + output.join(""), { cause: error }); }
  const compilationMs = performance.now() - start;
  const info = await withCurve(/* Lee las estadísticas del circuito realmente compilado. */ async () => r1cs.info(paths.r1cs));
  if (info.nPubInputs !== PUBLIC_SIGNAL_NAMES.length || info.nOutputs !== 0) throw new Error("El circuito expone un número inesperado de señales públicas u outputs");
  const report = {
    compilationMs, constraints: info.nConstraints, wires: info.nVars,
    publicInputs: info.nPubInputs, privateInputs: info.nPrvInputs, outputs: info.nOutputs,
    sourceSha256: await fileHash(paths.sourceCircuit), r1csSha256: await fileHash(paths.r1cs),
  };
  await writeJson(paths.compilation, report);
  return report;
}

/** Comprueba que el manifiesto y cada archivo corresponden a la misma versión del circuito. */
export async function ensureZkArtifacts(options = {}) {
  const paths = artifactPaths(options);
  let manifest;
  try { manifest = JSON.parse(await readFile(paths.manifest, "utf8")); }
  catch { throw new Error("Faltan artefactos Groth16 válidos; ejecuta npm run zk:setup"); }
  if (manifest.format !== MANIFEST_FORMAT || JSON.stringify(manifest.parameters) !== JSON.stringify(protocolParameters())) throw new Error("Parámetros Groth16 incompatibles; regenera los artefactos");
  if (JSON.stringify(manifest.versions) !== JSON.stringify(await installedVersions())) throw new Error("Las versiones de las herramientas no coinciden con el manifiesto");
  if (manifest.librarySha256 !== await circuitLibraryHash()) throw new Error("Los circuitos de circomlib cambiaron después del setup");
  if (manifest.compilerSha256 !== await fileHash(require.resolve("circom2/circom.wasm"))) throw new Error("El compilador Circom cambió después del setup");
  for (const name of ["sourceCircuit", "entry", "r1cs", "wasm", "sym", "ptau", "zkey", "verificationKey", "verifier"]) {
    if (!manifest.files?.[name] || manifest.files[name].sha256 !== await fileHash(paths[name])) throw new Error(`Artefacto incompatible o alterado: ${name}`);
  }
  const key = JSON.parse(await readFile(paths.verificationKey, "utf8"));
  if (key.protocol !== "groth16" || key.nPublic !== PUBLIC_SIGNAL_NAMES.length) throw new Error("La clave de verificación no corresponde a las ocho señales públicas");
  const identifier = createHash("sha256").update(JSON.stringify({ parameters: manifest.parameters, versions: manifest.versions, files: manifest.files, librarySha256: manifest.librarySha256, compilerSha256: manifest.compilerSha256 })).digest("hex");
  if (identifier !== manifest.artifactId) throw new Error("El identificador del manifiesto no coincide con sus archivos");
  return manifest;
}

/** Ejecuta una ceremonia local de desarrollo y genera las claves y el verificador de ese circuito. */
export async function setupGroth16(options = {}) {
  const paths = artifactPaths(options);
  if (options.force && options.resume) throw new Error("Utiliza --force para regenerar o --resume para recuperar, no ambos");
  if (fs.existsSync(paths.manifest) && !options.force && !options.resume) return ensureZkArtifacts(options);
  if (options.resume && (!fs.existsSync(paths.ptau) || !fs.existsSync(paths.zkey))) throw new Error("Para reanudar deben existir Powers of Tau y la clave final Groth16");
  const compilation = await compileCircuit(options);
  const power = Math.max(14, Math.ceil(Math.log2(compilation.constraints + compilation.publicInputs + 1)));
  if (power > 20) throw new Error("El circuito excede el tamaño previsto para el ensayo local");
  const setupStart = performance.now();
  /** Comunica el avance sin publicar entropía, semillas ni datos del testigo. */
  function progress(message) { options.onProgress?.(message); }
  const manifest = await withCurve(/* Prepara y comprueba las contribuciones reales de desarrollo. */ async (curve) => {
    const initialTau = path.join(paths.root, "powersOfTau_initial.ptau");
    const contributedTau = path.join(paths.root, "powersOfTau_contributed.ptau");
    const initialKey = path.join(paths.root, "circuit_initial.zkey");
    if (!options.resume) {
      progress("Creando Powers of Tau local de desarrollo...");
      await powersOfTau.newAccumulator(curve, power, initialTau);
      progress("Agregando la contribución aleatoria de desarrollo...");
      await powersOfTau.contribute(initialTau, contributedTau, "Contribución local de desarrollo", randomBytes(64).toString("hex"));
      progress("Preparando la segunda fase de Powers of Tau...");
      await powersOfTau.preparePhase2(contributedTau, paths.ptau);
    } else progress("Recuperando los artefactos locales y comprobando el circuito actual...");
    // snarkjs 0.7.6 deja abierto un PTau en su comprobación interna de H; el descriptor en memoria evita una fuga de FileHandle en Node 26.
    const preparedTau = { type: "mem", data: await readFile(paths.ptau) };
    let contribution;
    try {
      progress("Comprobando Powers of Tau...");
      if (!await powersOfTau.verify(preparedTau)) throw new Error("La comprobación de Powers of Tau falló");
      if (!options.resume) {
        progress("Preparando la clave específica y su contribución Groth16...");
        const initialized = await zKey.newZKey(paths.r1cs, preparedTau, initialKey);
        if (initialized === -1) throw new Error("No fue posible preparar la clave Groth16 para este circuito");
        contribution = await zKey.contribute(initialKey, paths.zkey, "Contribución Groth16 local de desarrollo", randomBytes(64).toString("hex"));
      }
      const preparedKey = { type: "mem", data: await readFile(paths.zkey) };
      try {
        progress("Comprobando la correspondencia de la clave con el R1CS...");
        if (!await zKey.verifyFromR1cs(paths.r1cs, preparedTau, preparedKey)) throw new Error("La clave Groth16 no corresponde al R1CS");
      } finally { preparedKey.data.fill(0); }
    } finally { preparedTau.data.fill(0); }
    const verificationKey = await zKey.exportVerificationKey(paths.zkey);
    await writeJson(paths.verificationKey, verificationKey);
    const template = await readFile(path.join(packageRoot("snarkjs"), "templates/verifier_groth16.sol.ejs"), "utf8");
    const verifier = await zKey.exportSolidityVerifier(paths.zkey, { groth16: template });
    await mkdir(path.dirname(paths.verifier), { recursive: true });
    await writeFile(paths.verifier, "/** Verificador Groth16 generado por snarkjs para las ocho señales públicas del protocolo. */\n" + verifier);
    const files = {};
    for (const name of ["sourceCircuit", "entry", "r1cs", "wasm", "sym", "ptau", "zkey", "verificationKey", "verifier"]) {
      files[name] = { path: path.relative(process.cwd(), paths[name]).replaceAll("\\", "/"), sha256: await fileHash(paths[name]) };
    }
    const parameters = protocolParameters();
    const versions = await installedVersions();
    const librarySha256 = await circuitLibraryHash();
    const compilerSha256 = await fileHash(require.resolve("circom2/circom.wasm"));
    const artifactId = createHash("sha256").update(JSON.stringify({ parameters, versions, files, librarySha256, compilerSha256 })).digest("hex");
    const result = {
      format: MANIFEST_FORMAT, artifactId, createdAt: new Date().toISOString(), parameters, versions,
      librarySha256, compilerSha256, files,
      setup: {
        origin: options.resume ? "Artefactos locales recuperados y comprobados contra el circuito actual" : "Powers of Tau generado localmente",
        trust: "Desarrollo: no acredita una ceremonia distribuida ni un setup de producción",
        participants: options.resume ? null : 1, resumed: options.resume === true, power,
        ...(contribution ? { groth16ContributionHash: Buffer.from(contribution).toString("hex") } : {}),
      },
      metrics: { ...compilation, setupMs: performance.now() - setupStart, setupResumed: options.resume === true },
    };
    await writeJson(paths.manifest, result);
    for (const filename of [initialTau, contributedTau, initialKey]) await rm(filename, { force: true });
    return result;
  });
  progress("Artefactos Groth16 preparados y comprobados.");
  return manifest;
}

/** Normaliza las ocho señales públicas sin convertir enteros criptográficos a Number. */
function normalizePublicSignals(values) {
  if (!Array.isArray(values) || values.length !== PUBLIC_SIGNAL_NAMES.length) throw new TypeError("Se requieren exactamente ocho señales públicas");
  const result = [];
  for (let index = 0; index < values.length; index++) result.push(parseField(values[index], PUBLIC_SIGNAL_NAMES[index]).toString());
  return result;
}

/** Valida los límites de cada entrada y prepara solamente los nombres aceptados por el circuito. */
function normalizeCircuitInputs(input) {
  exactKeys(input, [...PUBLIC_SIGNAL_NAMES, ...PRIVATE_INPUT_NAMES], "entradas del circuito");
  const result = {};
  for (const name of [...PUBLIC_SIGNAL_NAMES, ...PRIVATE_INPUT_NAMES]) {
    if (name === "merklePathElements" || name === "merklePathIndices") continue;
    result[name] = parseField(input[name], name).toString();
  }
  if (BigInt(result.protocolVersion) !== PROTOCOL_VERSION || BigInt(result.protocolDomain) !== PROTOCOL_DOMAIN) throw new RangeError("Versión o dominio de protocolo no admitidos");
  if (BigInt(result.sourceId) === 0n) throw new RangeError("sourceId debe ser positivo");
  if (BigInt(result.nonce) === 0n || BigInt(result.nonce) >= (1n << BigInt(NONCE_BITS))) throw new RangeError("El nonce debe ser no nulo y ocupar como máximo 248 bits");
  if (BigInt(result.chainId) === 0n || BigInt(result.chainId) >= (1n << 64n)) throw new RangeError("chainId debe ser positivo y menor que 2^64");
  for (const name of ["registrant", "registryAddress"]) if (BigInt(result[name]) >= (1n << 160n)) throw new RangeError(`${name} excede una dirección EVM de 20 bytes`);
  for (const name of ["merklePathElements", "merklePathIndices"]) {
    if (!Array.isArray(input[name]) || input[name].length !== MERKLE_DEPTH) throw new TypeError(`Longitud incorrecta de ${name}`);
    result[name] = [];
    for (const raw of input[name]) {
      const value = parseField(raw, name);
      if (name === "merklePathIndices" && value !== 0n && value !== 1n) throw new RangeError("Los índices Merkle deben ser 0 o 1");
      result[name].push(value.toString());
    }
  }
  return result;
}

/** Une una autorización firmada con su pertenencia al conjunto de fuentes reconocidas. */
export async function createProofInputs(authorizationPackage, membership) {
  const record = await normalizeAuthorizationPackage(authorizationPackage);
  const authorization = record.authorization;
  if (!await verifyAuthorizationSignature(authorization.signedAuthorizationHash, record.signature, record.publicKey)) throw new Error("La firma de autorización no es válida");
  if (!await verifySourceProof(membership)) throw new Error("La ruta de la fuente no pertenece a la raíz indicada");
  if (parseField(membership.sourceId) !== authorization.sourceId) throw new Error("La fuente de la ruta no coincide con la autorización");
  for (let index = 0; index < 2; index++) if (parseField(membership.publicKey[index]) !== record.publicKey[index]) throw new Error("La clave de la ruta no coincide con la firma");
  const context = authorization.context;
  const nullifier = await calculateNullifier({ sourceId: authorization.sourceId, nonce: authorization.nonce, protocolVersion: authorization.protocolVersion, chainId: context.chainId, registryAddress: context.registryAddress });
  return normalizeCircuitInputs({
    contentHash: authorization.contentHash, protocolVersion: authorization.protocolVersion,
    authorizedSourcesRoot: membership.root, nullifier, registrant: BigInt(context.registrant),
    chainId: context.chainId, registryAddress: BigInt(context.registryAddress), protocolDomain: context.protocolDomain,
    sourceId: authorization.sourceId, nonce: authorization.nonce, publicKeyX: record.publicKey[0], publicKeyY: record.publicKey[1],
    R8x: record.signature.R8[0], R8y: record.signature.R8[1], S: record.signature.S,
    merklePathElements: membership.merklePathElements, merklePathIndices: membership.merklePathIndices,
  });
}

/** Construye el testigo en memoria para evitar archivos privados parciales cuando una restricción falla. */
async function buildWitness(input, paths) {
  const normalized = normalizeCircuitInputs(input);
  const memory = { type: "mem" };
  const start = performance.now();
  await wtns.calculate(normalized, paths.wasm, memory, { sanityCheck: true });
  const publicSignals = [];
  for (const name of PUBLIC_SIGNAL_NAMES) publicSignals.push(normalized[name]);
  return { memory, publicSignals, witnessMs: performance.now() - start };
}

/** Genera un testigo privado y lo guarda solamente cuando se solicita esta operación explícita. */
export async function calculateWitness(inputs, options = {}) {
  const manifest = await ensureZkArtifacts(options);
  const paths = artifactPaths(options);
  const built = await buildWitness(inputs, paths);
  const witnessPath = path.resolve(options.witnessPath ?? path.join(paths.root, "witness-" + randomUUID() + ".wtns"));
  try {
    await mkdir(path.dirname(witnessPath), { recursive: true });
    await writeFile(witnessPath, built.memory.data, { flag: "wx", mode: 0o600 });
  } finally { built.memory.data.fill(0); }
  return { witnessPath, artifactId: manifest.artifactId, metrics: { witnessMs: built.witnessMs } };
}

/** Convierte la prueba al orden de coordenadas esperado por el verificador Solidity y por viem. */
export async function formatSolidityProof(proof, publicSignals) {
  const signals = normalizePublicSignals(publicSignals);
  const text = await groth16.exportSolidityCallData(proof, signals);
  const values = JSON.parse("[" + text + "]");
  /** Convierte las coordenadas hexadecimales del exportador a BigInt sin perder precisión. */
  function integers(value) {
    if (!Array.isArray(value)) return BigInt(value);
    const result = [];
    for (const item of value) result.push(integers(item));
    return result;
  }
  return { pA: integers(values[0]), pB: integers(values[1]), pC: integers(values[2]), publicSignals: integers(values[3]) };
}

/** Genera y verifica una prueba Groth16; el testigo permanece en memoria y nunca se incluye en la salida. */
export async function generateProof(inputs, options = {}) {
  const manifest = await ensureZkArtifacts(options);
  const paths = artifactPaths(options);
  const built = await buildWitness(inputs, paths);
  try {
    return await withCurve(/* Produce la prueba real y mide la verificación fuera de cadena. */ async () => {
      const proveStart = performance.now();
      const { proof, publicSignals } = await groth16.prove(paths.zkey, built.memory);
      const proveMs = performance.now() - proveStart;
      const signals = normalizePublicSignals(publicSignals);
      if (JSON.stringify(signals) !== JSON.stringify(built.publicSignals)) throw new Error("El orden de señales públicas del circuito no coincide con el protocolo");
      const key = JSON.parse(await readFile(paths.verificationKey, "utf8"));
      const verifyStart = performance.now();
      if (!await groth16.verify(key, signals, proof)) throw new Error("La prueba generada no pudo verificarse");
      const verifyMs = performance.now() - verifyStart;
      return {
        artifactId: manifest.artifactId, proof, publicSignals: signals,
        metrics: { witnessMs: built.witnessMs, proveMs, verifyMs, proofBytes: Buffer.byteLength(JSON.stringify(proof), "utf8") },
        solidity: await formatSolidityProof(proof, signals),
      };
    });
  } finally { built.memory.data.fill(0); }
}

/** Verifica una prueba contra la clave y las señales públicas del manifiesto vigente. */
export async function verifyProof(proof, publicSignals, options = {}) {
  await ensureZkArtifacts(options);
  const paths = artifactPaths(options);
  const signals = normalizePublicSignals(publicSignals);
  const key = JSON.parse(await readFile(paths.verificationKey, "utf8"));
  return withCurve(/* Rechaza pruebas mal construidas sin convertirlas en resultados de éxito. */ async () => {
    try { return await groth16.verify(key, signals, proof); }
    catch { return false; }
  });
}
