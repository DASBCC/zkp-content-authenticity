/** Centraliza los parámetros del protocolo ZKP, las señales públicas y el identificador de autorización consumida. */

import { randomBytes } from "node:crypto";
import { PROTOCOL_DOMAIN } from "./authorization.mjs";
import { bytesToBigIntBE, canonicalAddress, exactKeys, parseField } from "./encoding.mjs";
import { poseidonHash } from "./poseidon.mjs";

export { PROTOCOL_DOMAIN };
// Cada cambio de versión o profundidad exige recompilar y realizar un nuevo setup del circuito.
export const PROTOCOL_VERSION = 1n;
export const MERKLE_DEPTH = 8;
// Una semilla de 31 bytes aporta 248 bits y siempre cabe en el campo de Poseidon.
export const NONCE_BITS = 248;
export const NONCE_LIMIT = 1n << BigInt(NONCE_BITS);
// Las direcciones EVM deben caber en los 20 bytes que utiliza el contrato.
export const ADDRESS_LIMIT = 1n << 160n;
// La versión actual del circuito admite identificadores de cadena de hasta 64 bits.
export const CHAIN_ID_LIMIT = 1n << 64n;
// El orden coincide con las declaraciones del circuito y los índices del contrato Registry.
export const PUBLIC_SIGNAL_NAMES = Object.freeze([
  "contentHash", "protocolVersion", "authorizedSourcesRoot", "nullifier",
  "registrant", "chainId", "registryAddress", "protocolDomain",
]);

/**
 * Valida un número de un solo uso no nulo y menor que 2^248.
 * Entradas. Nonce candidato como BigInt o texto decimal.
 * Salida. Nonce validado como BigInt.
 */
export function validateNonce(value) {
  const nonce = parseField(value, "nonce", NONCE_LIMIT);
  if (nonce === 0n) throw new RangeError("nonce debe ser distinto de cero");
  return nonce;
}

/**
 * Genera un número de un solo uso con 248 bits aleatorios sin utilizar la clave de la fuente o de la billetera.
 * Entradas. Ningún argumento.
 * Salida. Nonce aleatorio no nulo como BigInt.
 */
export function generateNonce() {
  let nonce = 0n;
  while (nonce === 0n) nonce = bytesToBigIntBE(randomBytes(NONCE_BITS / 8));
  return nonce;
}

/**
 * Convierte una dirección EVM canónica o su entero decimal en un valor de campo de 160 bits.
 * Entradas. Dirección hexadecimal o entero de campo, con nombre opcional para diagnósticos.
 * Salida. Dirección representada como BigInt de hasta 160 bits.
 */
export function addressToField(value, name = "address") {
  if (typeof value === "string" && value.startsWith("0x")) return BigInt(canonicalAddress(value, name));
  return parseField(value, name, ADDRESS_LIMIT);
}

/**
 * Valida el identificador de una cadena compatible con los 64 bits definidos por el circuito v1.
 * Entradas. Identificador de cadena como BigInt o texto decimal.
 * Salida. BigInt positivo de hasta 64 bits.
 */
export function validateChainId(value) {
  const chainId = parseField(value, "chainId", CHAIN_ID_LIMIT);
  if (chainId === 0n) throw new RangeError("chainId debe ser positivo");
  return chainId;
}

/**
 * Calcula Poseidon(sourceId, nonce, protocolVersion, chainId, registryAddress) para impedir el uso repetido.
 * Entradas. Objeto con fuente, nonce, versión del protocolo, cadena y dirección del registro.
 * Salida. Promesa del nullifier Poseidon como BigInt.
 */
export async function calculateNullifier(input) {
  exactKeys(input, ["sourceId", "nonce", "protocolVersion", "chainId", "registryAddress"], "nullifier input");
  const sourceId = parseField(input.sourceId, "sourceId");
  if (sourceId === 0n) throw new RangeError("sourceId debe ser positivo");
  return poseidonHash([
    sourceId, validateNonce(input.nonce), parseField(input.protocolVersion, "protocolVersion"),
    validateChainId(input.chainId), addressToField(input.registryAddress, "registryAddress"),
  ]);
}

/**
 * Construye las ocho señales públicas en orden canónico, sin incorporar datos privados de la fuente.
 * Entradas. Objeto con los valores de las ocho señales públicas del protocolo.
 * Salida. Arreglo de ocho cadenas decimales en el orden que espera Circom y Solidity.
 */
export function publicSignalsFromInput(input) {
  if (parseField(input.protocolVersion, "protocolVersion") !== PROTOCOL_VERSION ||
      parseField(input.protocolDomain, "protocolDomain") !== PROTOCOL_DOMAIN) throw new RangeError("Versión o dominio de protocolo no admitidos");
  return PUBLIC_SIGNAL_NAMES.map(/* Recupera una señal pública y conserva su representación decimal exacta. Entradas. Nombre de una señal pública del protocolo. Salida. Cadena decimal con el valor validado. */ (name) => {
    const value = name === "registrant" || name === "registryAddress"
      ? addressToField(input[name], name)
      : name === "chainId" ? validateChainId(input[name]) : parseField(input[name], name);
    return value.toString();
  });
}
