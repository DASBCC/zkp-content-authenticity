/** Deriva claves públicas y gestiona firmas EdDSA/BabyJubJub con Poseidon y sus entradas para Circom. */

import { buildEddsa } from "circomlibjs";
import { exactKeys, parseField, stringifyCrypto, SUBGROUP_ORDER } from "./encoding.mjs";
import { validatePrivateKey } from "./key-management.mjs";

// Guarda la promesa de inicialización para no reconstruir los parámetros criptográficos en cada firma.
let instance;
/** Inicializa EdDSA/BabyJubJub de circomlibjs una sola vez y reutiliza su promesa. */
function getEddsa() {
  instance ??= buildEddsa();
  return instance;
}

/** Convierte las coordenadas a BigInt y exige un punto no neutro del subgrupo BabyJubJub. */
async function normalizePoint(value, name) {
  if (!Array.isArray(value) || value.length !== 2) throw new TypeError(`${name}: se requieren dos coordenadas`);
  const coordinates = value.map(/* Valida cada coordenada como entero de campo. */ (item, index) => parseField(item, `${name}[${index}]`));
  const eddsa = await getEddsa();
  // La API expone BigInt; circomlibjs necesita su propia representación interna de campo.
  const point = coordinates.map(/* Convierte cada coordenada al formato interno de circomlibjs. */ (item) => eddsa.F.e(item));
  if (!eddsa.babyJub.inSubgroup(point) || (coordinates[0] === 0n && coordinates[1] === 1n)) {
    throw new TypeError(`${name}: se requiere un punto no neutro del subgrupo BabyJubJub`);
  }
  return coordinates;
}

/** Valida la clave pública como un par de coordenadas BabyJubJub y devuelve sus BigInt. */
export async function validatePublicKey(publicKey) {
  return normalizePoint(publicKey, "publicKey");
}

/** Valida el punto R8 y el rango del escalar S, y devuelve la firma normalizada. */
export async function normalizeSignature(signature) {
  exactKeys(signature, ["R8", "S"], "signature");
  return {
    R8: await normalizePoint(signature.R8, "signature.R8"),
    S: parseField(signature.S, "signature.S", SUBGROUP_ORDER),
  };
}

/** Deriva las coordenadas públicas BabyJubJub a partir de una semilla privada de 32 bytes. */
export async function derivePublicKey(privateKey) {
  const seed = validatePrivateKey(privateKey);
  try {
    const eddsa = await getEddsa();
    return validatePublicKey(eddsa.prv2pub(seed).map(/* Convierte la coordenada de campo a BigInt. */ (value) => eddsa.F.toObject(value)));
  } finally {
    seed.fill(0);
  }
}

/** Firma signedAuthorizationHash con EdDSA/Poseidon y devuelve R8 y S como BigInt. */
export async function signAuthorizationHash(signedAuthorizationHash, privateKey) {
  const message = parseField(signedAuthorizationHash, "signedAuthorizationHash");
  const seed = validatePrivateKey(privateKey);
  try {
    const eddsa = await getEddsa();
    // Se firma el elemento de campo, no los bytes de su representación decimal.
    const signature = eddsa.signPoseidon(seed, eddsa.F.e(message));
    return normalizeSignature({ R8: signature.R8.map(/* Convierte la coordenada de campo a BigInt. */ (value) => eddsa.F.toObject(value)), S: signature.S });
  } finally {
    seed.fill(0);
  }
}

/** Devuelve si la firma corresponde al mensaje y la clave; las entradas mal formadas lanzan error. */
export async function verifyAuthorizationSignature(signedAuthorizationHash, signature, publicKey) {
  const message = parseField(signedAuthorizationHash, "signedAuthorizationHash");
  const normalized = await normalizeSignature(signature);
  const key = await validatePublicKey(publicKey);
  const eddsa = await getEddsa();
  return eddsa.verifyPoseidon(eddsa.F.e(message), {
    R8: normalized.R8.map(/* Convierte la coordenada al formato interno de circomlibjs. */ (value) => eddsa.F.e(value)), S: normalized.S,
  }, key.map(/* Convierte la coordenada al formato interno de circomlibjs. */ (value) => eddsa.F.e(value)));
}

/** Valida la firma y serializa sus coordenadas y su escalar como cadenas decimales en JSON. */
export async function serializeSignature(signature) {
  return stringifyCrypto(await normalizeSignature(signature));
}

/** Recupera una firma desde JSON decimal y comprueba sus coordenadas y el rango de S. */
export async function deserializeSignature(json) {
  const value = JSON.parse(json);
  if (typeof value?.S !== "string" || !Array.isArray(value?.R8) || value.R8.some(/* Detecta coordenadas que no están representadas como texto. */ (item) => typeof item !== "string")) {
    throw new TypeError("La firma JSON debe usar cadenas decimales");
  }
  return normalizeSignature(value);
}

/** Verifica la firma y exporta los nombres de entrada que espera EdDSAPoseidonVerifier. */
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
