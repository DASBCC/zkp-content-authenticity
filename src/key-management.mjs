/** Genera, valida y guarda semillas EdDSA de fuentes autorizadas, y permite cargarlas desde archivos o el entorno. */

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { exactKeys } from "./encoding.mjs";

// Etiqueta del formato de archivo que contiene la semilla EdDSA de la fuente autorizada.
export const PRIVATE_KEY_FORMAT = "eddsa-babyjubjub-poseidon-seed-v1";

/**
 * Valida una semilla no nula de 32 bytes y devuelve una copia independiente de la clave de fuente.
 * Entradas. Valor candidato a semilla EdDSA.
 * Salida. Copia de la semilla validada como Uint8Array de 32 bytes.
 */
export function validatePrivateKey(value) {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new TypeError("La clave de fuente debe contener exactamente 32 bytes");
  }
  if (value.every(/* Comprueba si el octeto de la semilla es cero. Entradas. Octeto de la semilla. Salida. true si el octeto es cero. */ (byte) => byte === 0)) throw new TypeError("La clave de fuente no puede ser nula");
  return new Uint8Array(value);
}

/**
 * Decodifica una semilla de 64 caracteres hexadecimales minúsculos, sin prefijo 0x.
 * Entradas. Cadena de 64 dígitos hexadecimales en minúsculas sin prefijo.
 * Salida. Semilla EdDSA validada como Uint8Array.
 */
export function privateKeyFromHex(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError("Clave de fuente inválida: se requieren 64 caracteres hexadecimales minúsculos sin 0x");
  }
  return validatePrivateKey(Uint8Array.from(value.match(/../g), /* Interpreta cada par hexadecimal como un octeto. Entradas. Par de caracteres hexadecimales. Salida. Número de 0 a 255 para el arreglo de bytes. */ (byte) => parseInt(byte, 16)));
}

/**
 * Genera una semilla privada de 32 bytes con el generador criptográficamente seguro de Node.js.
 * Entradas. Ningún argumento.
 * Salida. Semilla EdDSA no nula de 32 bytes como Uint8Array.
 */
export function generatePrivateKey() {
  return validatePrivateKey(randomBytes(32));
}

/**
 * Guarda la semilla en un archivo nuevo con permisos 0600 solicitados.
 * Entradas. Ruta de destino y semilla privada como Uint8Array.
 * Salida. Promesa sin valor. Escribe el archivo y limpia la copia de la semilla.
 */
export async function savePrivateKey(path, privateKey) {
  const seed = validatePrivateKey(privateKey);
  try {
    await writeFile(path, JSON.stringify({ format: PRIVATE_KEY_FORMAT, seed: Buffer.from(seed).toString("hex") }) + "\n", {
      flag: "wx", mode: 0o600,
    });
  } finally {
    seed.fill(0);
  }
}

/**
 * Carga la semilla desde un archivo o SOURCE_EDDSA_PRIVATE_KEY y rechaza usar ambos orígenes.
 * Entradas. Opciones con ruta del archivo o entorno con SOURCE_EDDSA_PRIVATE_KEY.
 * Salida. Promesa de la semilla validada como Uint8Array de 32 bytes.
 * @param {{filePath?: string, env?: Record<string, string | undefined>}} [options] Origen de archivo o variables de entorno permitidas.
 */
export async function loadPrivateKey({ filePath, env = process.env } = {}) {
  const secret = env.SOURCE_EDDSA_PRIVATE_KEY;
  if (filePath && secret) throw new Error("Configura solo un origen para la clave privada de fuente");
  if (secret) return privateKeyFromHex(secret);
  if (!filePath) throw new Error("Falta la clave de fuente: --key o SOURCE_EDDSA_PRIVATE_KEY");
  let value;
  try {
    value = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new TypeError("Archivo de clave inválido");
    throw error;
  }
  exactKeys(value, ["format", "seed"], "private key file");
  if (value.format !== PRIVATE_KEY_FORMAT) throw new TypeError("Formato de clave de fuente incompatible");
  return privateKeyFromHex(value.seed);
}
