/** Construye autorizaciones ligadas a un contexto, gestiona paquetes firmados y exporta entradas para el circuito. */

import { canonicalAddress, exactKeys, parseField, stringifyCrypto } from "./encoding.mjs";
import { poseidonHash } from "./poseidon.mjs";
import { derivePublicKey, exportVerifierInputs, normalizeSignature, signAuthorizationHash, validatePublicKey, verifyAuthorizationSignature } from "./eddsa.mjs";

// Dominio v1: texto ASCII de "zkp-content-authenticity:v1" convertido a entero con el byte de mayor peso primero.
export const PROTOCOL_DOMAIN = BigInt("0x7a6b702d636f6e74656e742d61757468656e7469636974793a7631");
// Campos obligatorios de la autorización base y orden exacto de las entradas de Poseidon.
const BASE_KEYS = ["contentHash", "protocolVersion", "sourceId", "nonce"];
// Propiedades que debe suministrar el llamador para vincular la firma con una operación concreta.
const CONTEXT_KEYS = ["registrant", "chainId", "registryAddress", "protocolDomain"];

/**
 * Valida los cuatro datos base y los convierte a BigInt en el orden del protocolo.
 * Entradas. Objeto base con contentHash, protocolVersion, sourceId y nonce.
 * Salida. Objeto con los cuatro campos como BigInt.
 */
export function normalizeAuthorizationBase(base) {
  exactKeys(base, BASE_KEYS, "authorization");
  return Object.fromEntries(BASE_KEYS.map(/* Asocia cada campo base con su BigInt validado. Entradas. Nombre de un campo de la autorización base. Salida. Par con el nombre y su valor BigInt validado. */ (key) => [key, parseField(base[key], key)]));
}

/**
 * Valida las direcciones y los valores de campo del contexto recibido para la operación.
 * Entradas. Contexto con registrant, chainId, registryAddress y protocolDomain.
 * Salida. Contexto con direcciones en minúsculas y cadena y dominio como BigInt.
 */
export function normalizeOperationContext(context) {
  exactKeys(context, CONTEXT_KEYS, "context");
  const chainId = parseField(context.chainId, "chainId");
  if (chainId === 0n) throw new RangeError("chainId debe ser positivo");
  return {
    registrant: canonicalAddress(context.registrant, "registrant"),
    chainId,
    registryAddress: canonicalAddress(context.registryAddress, "registryAddress"),
    protocolDomain: parseField(context.protocolDomain, "protocolDomain"),
  };
}

/**
 * Calcula Poseidon(contentHash, protocolVersion, sourceId, nonce) y devuelve un BigInt.
 * Entradas. Autorización base con huella, versión, fuente y nonce.
 * Salida. Promesa del hash base como BigInt.
 */
export async function calculateAuthorizationHash(base) {
  const value = normalizeAuthorizationBase(base);
  return poseidonHash(BASE_KEYS.map(/* Extrae los valores en el orden requerido por Poseidon. Entradas. Nombre de un campo base. Salida. Valor BigInt asociado a ese nombre. */ (key) => value[key]));
}

/**
 * Calcula el compromiso Poseidon del registrante, la red, el registro y el dominio.
 * Entradas. Contexto con las dos direcciones EVM, la cadena y el dominio.
 * Salida. Promesa del hash del contexto como BigInt.
 */
export async function calculateOperationContext(context) {
  const value = normalizeOperationContext(context);
  return poseidonHash([BigInt(value.registrant), value.chainId, BigInt(value.registryAddress), value.protocolDomain]);
}

/**
 * Combina la autorización base y su contexto para obtener el elemento de campo que se firma.
 * Entradas. Hash base y contexto de la operación.
 * Salida. Promesa del hash firmado como BigInt.
 */
export async function calculateSignedAuthorizationHash(authorizationHash, context) {
  return poseidonHash([parseField(authorizationHash, "authorizationHash"), await calculateOperationContext(context)]);
}

/**
 * Construye las tres huellas de autorización usando el contexto explícito de la operación.
 * Entradas. Campos base y contexto de una operación de registro.
 * Salida. Promesa de la autorización normalizada con sus tres hashes.
 */
export async function createAuthorization(input) {
  exactKeys(input, [...BASE_KEYS, "context"], "authorization input");
  const { context: rawContext, ...rawBase } = input;
  const base = normalizeAuthorizationBase(rawBase);
  const context = normalizeOperationContext(rawContext);
  const authorizationHash = await calculateAuthorizationHash(base);
  const operationContext = await calculateOperationContext(context);
  const signedAuthorizationHash = await poseidonHash([authorizationHash, operationContext]);
  return { ...base, context, authorizationHash, operationContext, signedAuthorizationHash };
}

// Identifica el algoritmo y la versión del esquema JSON del paquete de autorización.
export const AUTHORIZATION_FORMAT = "eddsa-babyjubjub-poseidon-authorization-v1";
// Propiedades completas que se esperan dentro de la autorización serializada.
const AUTH_KEYS = ["contentHash", "protocolVersion", "sourceId", "nonce", "context", "authorizationHash", "operationContext", "signedAuthorizationHash"];

/**
 * Construye la autorización, deriva la clave pública y firma la huella vinculada al contexto.
 * Entradas. Datos base, contexto y semilla EdDSA privada de 32 bytes.
 * Salida. Promesa del paquete con formato, autorización, clave pública y firma.
 */
export async function signContentAuthorization(input, privateKey) {
  const authorization = await createAuthorization(input);
  const publicKey = await derivePublicKey(privateKey);
  const signature = await signAuthorizationHash(authorization.signedAuthorizationHash, privateKey);
  return { format: AUTHORIZATION_FORMAT, authorization, publicKey, signature };
}

/**
 * Comprueba el formato y la coherencia interna del paquete de autorización.
 * Entradas. Paquete de autorización con firma, clave y hashes declarados.
 * Salida. Promesa del paquete normalizado con los hashes recalculados.
 */
export async function normalizeAuthorizationPackage(value) {
  exactKeys(value, ["format", "authorization", "publicKey", "signature"], "authorization package");
  if (value.format !== AUTHORIZATION_FORMAT) throw new TypeError("Formato de autorización incompatible");
  exactKeys(value.authorization, AUTH_KEYS, "authorization record");
  const { authorizationHash, operationContext, signedAuthorizationHash, ...input } = value.authorization;
  const rebuilt = await createAuthorization(input);
  for (const key of ["authorizationHash", "operationContext", "signedAuthorizationHash"]) {
    if (parseField(value.authorization[key], key) !== rebuilt[key]) throw new Error(`Autorización inconsistente: ${key}`);
  }
  return {
    format: AUTHORIZATION_FORMAT, authorization: rebuilt,
    publicKey: await validatePublicKey(value.publicKey), signature: await normalizeSignature(value.signature),
  };
}

/**
 * Valida el paquete y lo convierte a JSON con enteros representados como cadenas decimales.
 * Entradas. Paquete de autorización que se quiere almacenar o transferir.
 * Salida. Promesa de una cadena JSON con los enteros en decimal.
 */
export async function serializeAuthorizationPackage(value) {
  return stringifyCrypto(await normalizeAuthorizationPackage(value));
}

/**
 * Lee un paquete JSON, rechaza números que puedan perder precisión y normaliza sus datos.
 * Entradas. Cadena JSON con los enteros criptográficos como texto decimal.
 * Salida. Promesa del paquete de autorización normalizado.
 */
export async function deserializeAuthorizationPackage(json) {
  const value = JSON.parse(json);
  /**
   * Recorre el JSON para comprobar la representación de los enteros.
   * Entradas. Valor del JSON analizado, incluidos objetos y arreglos anidados.
   * Salida. Sin valor de retorno. Lanza TypeError si encuentra un Number.
   */
  const inspect = (item) => {
    if (typeof item === "number") throw new TypeError("El JSON criptográfico debe usar cadenas decimales");
    if (item && typeof item === "object") Object.values(item).forEach(inspect);
  };
  inspect(value);
  return normalizeAuthorizationPackage(value);
}

/**
 * Verifica el contenido y la operación esperados usando una clave pública de confianza independiente.
 * Entradas. Paquete firmado, huella esperada, operación esperada y clave pública de confianza.
 * Salida. Promesa de true si coinciden los datos esperados y la firma es válida, o false si difieren.
 */
export async function verifyContentAuthorization(value, { contentHash, operation, publicKey }) {
  exactKeys(operation, ["protocolVersion", "sourceId", "nonce", "context"], "operation");
  const record = await normalizeAuthorizationPackage(value);
  const trustedKey = await validatePublicKey(publicKey);
  const expected = await createAuthorization({ contentHash, ...operation });
  if (record.publicKey.some(/* Detecta una coordenada que difiere de la clave de confianza. Entradas. Coordenada de la clave del paquete e índice. Salida. true si difiere de la coordenada de confianza. */ (coordinate, index) => coordinate !== trustedKey[index])) return false;
  if (record.authorization.signedAuthorizationHash !== expected.signedAuthorizationHash) return false;
  return verifyAuthorizationSignature(expected.signedAuthorizationHash, record.signature, trustedKey);
}

/**
 * Exporta la firma, la clave pública y los datos auxiliares como entradas del circuito, sin la semilla privada.
 * Entradas. Paquete de autorización firmado.
 * Salida. Promesa de las entradas de Circom como cadenas decimales.
 */
export async function exportProverInputs(value) {
  const record = await normalizeAuthorizationPackage(value);
  const { authorization: auth, signature, publicKey } = record;
  const verifier = await exportVerifierInputs(auth.signedAuthorizationHash, signature, publicKey);
  return {
    ...verifier, contentHash: auth.contentHash.toString(), protocolVersion: auth.protocolVersion.toString(),
    sourceId: auth.sourceId.toString(), nonce: auth.nonce.toString(),
    registrant: BigInt(auth.context.registrant).toString(), chainId: auth.context.chainId.toString(),
    registryAddress: BigInt(auth.context.registryAddress).toString(), protocolDomain: auth.context.protocolDomain.toString(),
    authorizationHash: auth.authorizationHash.toString(), operationContext: auth.operationContext.toString(),
  };
}
