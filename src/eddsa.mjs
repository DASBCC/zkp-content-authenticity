/** Deriva claves públicas y gestiona firmas EdDSA/BabyJubJub con Poseidon y sus entradas para Circom. */

import { buildEddsa } from "circomlibjs";
import { exactKeys, parseField, stringifyCrypto, SUBGROUP_ORDER } from "./encoding.mjs";
import { validatePrivateKey } from "./key-management.mjs";

// Guarda la promesa de inicialización para no reconstruir los parámetros criptográficos en cada firma.
let instance;
/**
 * Inicializa EdDSA/BabyJubJub de circomlibjs una sola vez y reutiliza su promesa.
 * Entradas. Ningún argumento.
 * Salida. Promesa compartida de la instancia EdDSA/BabyJubJub.
 */
function getEddsa() {
  instance ??= buildEddsa();
  return instance;
}

/**
 * Convierte las coordenadas a BigInt y exige un punto no neutro del subgrupo BabyJubJub.
 * Entradas. Par de coordenadas y nombre del dato para diagnósticos.
 * Salida. Promesa del par de coordenadas como BigInt.
 */
async function normalizePoint(value, name) {
  if (!Array.isArray(value) || value.length !== 2) throw new TypeError(`${name}: se requieren dos coordenadas`);
  const coordinates = value.map(/* Valida cada coordenada como entero de campo. Entradas. Coordenada e índice del par. Salida. Valor de campo como BigInt. */ (item, index) => parseField(item, `${name}[${index}]`));
  const eddsa = await getEddsa();
  // La API expone BigInt; circomlibjs necesita su propia representación interna de campo.
  const point = coordinates.map(/* Convierte cada coordenada al formato interno de circomlibjs. Entradas. Coordenada normalizada. Salida. Elemento de campo interno de circomlibjs. */ (item) => eddsa.F.e(item));
  if (!eddsa.babyJub.inSubgroup(point) || (coordinates[0] === 0n && coordinates[1] === 1n)) {
    throw new TypeError(`${name}: se requiere un punto no neutro del subgrupo BabyJubJub`);
  }
  return coordinates;
}

/**
 * Valida la clave pública como un par de coordenadas BabyJubJub y devuelve sus BigInt.
 * Entradas. Clave pública con las dos coordenadas de BabyJubJub.
 * Salida. Promesa de la clave normalizada como par de BigInt.
 */
export async function validatePublicKey(publicKey) {
  return normalizePoint(publicKey, "publicKey");
}

/**
 * Valida el punto R8 y el rango del escalar S, y devuelve la firma normalizada.
 * Entradas. Objeto con el punto R8 y el escalar S.
 * Salida. Promesa de la firma normalizada con coordenadas y escalar BigInt.
 */
export async function normalizeSignature(signature) {
  exactKeys(signature, ["R8", "S"], "signature");
  return {
    R8: await normalizePoint(signature.R8, "signature.R8"),
    S: parseField(signature.S, "signature.S", SUBGROUP_ORDER),
  };
}

/**
 * Deriva las coordenadas públicas BabyJubJub a partir de una semilla privada de 32 bytes.
 * Entradas. Semilla de fuente no nula de 32 bytes.
 * Salida. Promesa del par de coordenadas de la clave pública como BigInt.
 */
export async function derivePublicKey(privateKey) {
  const seed = validatePrivateKey(privateKey);
  try {
    const eddsa = await getEddsa();
    return validatePublicKey(eddsa.prv2pub(seed).map(/* Convierte la coordenada de campo a BigInt. Entradas. Coordenada del punto público en formato interno. Salida. Coordenada como BigInt. */ (value) => eddsa.F.toObject(value)));
  } finally {
    seed.fill(0);
  }
}

/**
 * Firma signedAuthorizationHash con EdDSA/Poseidon y devuelve R8 y S como BigInt.
 * Entradas. Hash firmado de la autorización y semilla privada de la fuente.
 * Salida. Promesa de la firma EdDSA con R8 y S como BigInt.
 */
export async function signAuthorizationHash(signedAuthorizationHash, privateKey) {
  const message = parseField(signedAuthorizationHash, "signedAuthorizationHash");
  const seed = validatePrivateKey(privateKey);
  try {
    const eddsa = await getEddsa();
    // Se firma el elemento de campo, no los bytes de su representación decimal.
    const signature = eddsa.signPoseidon(seed, eddsa.F.e(message));
    return normalizeSignature({ R8: signature.R8.map(/* Convierte la coordenada de campo a BigInt. Entradas. Coordenada interna del punto R8. Salida. Coordenada como BigInt. */ (value) => eddsa.F.toObject(value)), S: signature.S });
  } finally {
    seed.fill(0);
  }
}

/**
 * Verifica una firma EdDSA/Poseidon y rechaza entradas mal formadas.
 * Entradas. Hash firmado, firma EdDSA y clave pública de la fuente.
 * Salida. Promesa de true si la firma corresponde al mensaje y la clave, o false si la verificación falla.
 */
export async function verifyAuthorizationSignature(signedAuthorizationHash, signature, publicKey) {
  const message = parseField(signedAuthorizationHash, "signedAuthorizationHash");
  const normalized = await normalizeSignature(signature);
  const key = await validatePublicKey(publicKey);
  const eddsa = await getEddsa();
  return eddsa.verifyPoseidon(eddsa.F.e(message), {
    R8: normalized.R8.map(/* Convierte la coordenada al formato interno de circomlibjs. Entradas. Coordenada BigInt del punto R8. Salida. Elemento de campo interno de circomlibjs. */ (value) => eddsa.F.e(value)), S: normalized.S,
  }, key.map(/* Convierte la coordenada al formato interno de circomlibjs. Entradas. Coordenada BigInt de la clave pública. Salida. Elemento de campo interno de circomlibjs. */ (value) => eddsa.F.e(value)));
}

/**
 * Valida la firma y serializa sus coordenadas y su escalar como cadenas decimales en JSON.
 * Entradas. Firma EdDSA con R8 y S.
 * Salida. Promesa de una cadena JSON con coordenadas y escalar en texto decimal.
 */
export async function serializeSignature(signature) {
  return stringifyCrypto(await normalizeSignature(signature));
}

/**
 * Recupera una firma desde JSON decimal y comprueba sus coordenadas y el rango de S.
 * Entradas. Cadena JSON con R8 y S representados como texto decimal.
 * Salida. Promesa de la firma EdDSA con coordenadas y escalar BigInt.
 */
export async function deserializeSignature(json) {
  const value = JSON.parse(json);
  if (typeof value?.S !== "string" || !Array.isArray(value?.R8) || value.R8.some(/* Detecta coordenadas que no están representadas como texto. Entradas. Valor candidato a coordenada R8. Salida. true si el valor no es una cadena. */ (item) => typeof item !== "string")) {
    throw new TypeError("La firma JSON debe usar cadenas decimales");
  }
  return normalizeSignature(value);
}

/**
 * Verifica la firma y exporta los nombres de entrada que espera EdDSAPoseidonVerifier.
 * Entradas. Hash firmado, firma EdDSA y clave pública.
 * Salida. Promesa del objeto con enabled, Ax, Ay, R8x, R8y, S y M como texto decimal.
 */
export async function exportVerifierInputs(signedAuthorizationHash, signature, publicKey) {
  if (!await verifyAuthorizationSignature(signedAuthorizationHash, signature, publicKey)) {
    throw new Error("No se pueden exportar inputs de una firma inválida");
  }
  const key = await validatePublicKey(publicKey);
  const sig = await normalizeSignature(signature);
  return {
    enabled: "1", Ax: key[0].toString(), Ay: key[1].toString(),
    R8x: sig.R8[0].toString(), R8y: sig.R8[1].toString(), S: sig.S.toString(),
    M: parseField(signedAuthorizationHash).toString(),
  };
}
