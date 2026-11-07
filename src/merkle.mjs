/** Construye y actualiza el conjunto de fuentes autorizadas y sus pruebas Merkle con Poseidon. */

import { exactKeys, parseField } from "./encoding.mjs";
import { validatePublicKey } from "./eddsa.mjs";
import { poseidonHash } from "./poseidon.mjs";
import { MERKLE_DEPTH } from "./protocol.mjs";

// La profundidad del protocolo determina una capacidad fija y las ocho etapas de cada ruta.
export const MERKLE_CAPACITY = 2 ** MERKLE_DEPTH;
// Una posición sin fuente autorizada contiene el cero del campo; los niveles superiores se calculan con Poseidon.
export const EMPTY_SOURCE_LEAF = 0n;
// El formato incluye la relación fuente-clave para reconstruir la hoja sin confiar en un valor aislado.
const PROOF_KEYS = ["sourceId", "publicKey", "leaf", "root", "merklePathElements", "merklePathIndices"];

/**
 * Valida un identificador de fuente positivo y lo devuelve como BigInt canónico.
 * Entradas. Identificador de fuente como BigInt o texto decimal.
 * Salida. Identificador positivo del campo como BigInt.
 */
function normalizeSourceId(value) {
  const sourceId = parseField(value, "sourceId");
  if (sourceId === 0n) throw new RangeError("sourceId debe ser positivo");
  return sourceId;
}

/**
 * Valida la pareja fuente-clave y crea una copia inmutable de sus datos normalizados.
 * Entradas. Objeto con sourceId y publicKey.
 * Salida. Promesa de la fuente normalizada e inmutable.
 */
async function normalizeSource(value) {
  exactKeys(value, ["sourceId", "publicKey"], "fuente autorizada");
  const sourceId = normalizeSourceId(value.sourceId);
  const publicKey = Object.freeze(await validatePublicKey(value.publicKey));
  return Object.freeze({ sourceId, publicKey });
}

/**
 * Ordena fuentes por su identificador numérico sin convertir valores de campo a Number.
 * Entradas. Dos fuentes con identificadores normalizados.
 * Salida. -1, 0 o 1 según el orden numérico de sus identificadores.
 */
function compareSources(first, second) {
  if (first.sourceId === second.sourceId) return 0;
  return first.sourceId < second.sourceId ? -1 : 1;
}

/**
 * Valida el conjunto completo, aplica el orden canónico y rechaza identificadores repetidos.
 * Entradas. Arreglo de fuentes con identificador y clave pública.
 * Salida. Promesa de un arreglo normalizado y ordenado por identificador.
 */
async function normalizeSources(sources) {
  if (!Array.isArray(sources)) throw new TypeError("Se requiere un arreglo de fuentes autorizadas");
  if (sources.length > MERKLE_CAPACITY) throw new RangeError(`El árbol admite hasta ${MERKLE_CAPACITY} fuentes`);
  const result = [];
  for (const source of sources) result.push(await normalizeSource(source));
  result.sort(compareSources);
  for (let index = 1; index < result.length; index++) {
    if (result[index - 1].sourceId === result[index].sourceId) {
      throw new TypeError("El conjunto contiene un sourceId repetido");
    }
  }
  return result;
}

/**
 * Localiza una fuente por su identificador y devuelve un índice de arreglo, o -1 si no existe.
 * Entradas. Arreglo de fuentes e identificador de búsqueda como BigInt.
 * Salida. Índice de la fuente o -1 si no aparece.
 */
function findSourceIndex(sources, sourceId) {
  for (let index = 0; index < sources.length; index++) {
    if (parseField(sources[index].sourceId, "sourceId") === sourceId) return index;
  }
  return -1;
}

/**
 * Calcula la única relación de hoja del protocolo a partir de una fuente ya normalizada.
 * Entradas. Fuente normalizada con identificador y coordenadas BabyJubJub.
 * Salida. Promesa del hash de la hoja como BigInt.
 */
function hashNormalizedSource(source) {
  return poseidonHash([source.sourceId, source.publicKey[0], source.publicKey[1]]);
}

/**
 * Calcula Poseidon(sourceId, publicKeyX, publicKeyY) después de validar los tres valores.
 * Entradas. Fuente con identificador y clave pública.
 * Salida. Promesa de la hoja Poseidon como BigInt.
 */
export async function createSourceLeaf(source) {
  return hashNormalizedSource(await normalizeSource(source));
}

/**
 * Construye el árbol de profundidad fija con hojas vacías a cero y padres Poseidon.
 * Entradas. Arreglo de fuentes autorizadas con sus identificadores y claves públicas.
 * Salida. Promesa de un árbol inmutable con raíz, profundidad, fuentes, hojas y niveles.
 */
export async function buildAuthorizedSourcesTree(sources) {
  const normalized = await normalizeSources(sources);
  const leaves = new Array(MERKLE_CAPACITY).fill(EMPTY_SOURCE_LEAF);
  for (let index = 0; index < normalized.length; index++) leaves[index] = await hashNormalizedSource(normalized[index]);
  const layers = [Object.freeze(leaves)];
  for (let level = 0; level < MERKLE_DEPTH; level++) {
    const current = layers[level];
    const parents = [];
    for (let index = 0; index < current.length; index += 2) {
      parents.push(await poseidonHash([current[index], current[index + 1]]));
    }
    layers.push(Object.freeze(parents));
  }
  return Object.freeze({
    depth: MERKLE_DEPTH,
    sources: Object.freeze(normalized),
    root: layers[MERKLE_DEPTH][0],
    leaves: layers[0],
    layers: Object.freeze(layers),
  });
}

/**
 * Construye una prueba Merkle desde la hoja hasta la raíz y verifica su consistencia.
 * Entradas. Árbol de fuentes e identificador de la fuente autorizada.
 * Salida. Promesa de la prueba con fuente, clave, hoja, raíz, hermanos y direcciones.
 */
export async function getSourceProof(tree, value) {
  exactKeys(tree, ["depth", "sources", "root", "leaves", "layers"], "árbol de fuentes");
  if (tree.depth !== MERKLE_DEPTH || !Array.isArray(tree.sources) || !Array.isArray(tree.layers) ||
      tree.layers.length !== MERKLE_DEPTH + 1 || !Array.isArray(tree.leaves) || tree.leaves.length !== MERKLE_CAPACITY) {
    throw new TypeError("La estructura del árbol no corresponde a la profundidad del protocolo");
  }
  const sourceId = normalizeSourceId(value);
  const sourceIndex = findSourceIndex(tree.sources, sourceId);
  if (sourceIndex < 0) throw new Error("La fuente no está autorizada en este árbol");
  const source = await normalizeSource(tree.sources[sourceIndex]);
  const merklePathElements = [];
  const merklePathIndices = [];
  let index = sourceIndex;
  for (let level = 0; level < MERKLE_DEPTH; level++) {
    const layer = tree.layers[level];
    if (!Array.isArray(layer) || layer.length !== 2 ** (MERKLE_DEPTH - level)) {
      throw new TypeError("La estructura de niveles del árbol es inválida");
    }
    merklePathElements.push(parseField(layer[index ^ 1], `hermano[${level}]`));
    merklePathIndices.push(BigInt(index % 2));
    index = Math.floor(index / 2);
  }
  const proof = {
    sourceId: source.sourceId,
    publicKey: [...source.publicKey],
    leaf: await hashNormalizedSource(source),
    root: parseField(tree.root, "raíz"),
    merklePathElements,
    merklePathIndices,
  };
  if (!await verifySourceProof(proof)) throw new Error("La ruta no corresponde a la raíz declarada del árbol");
  return proof;
}

/**
 * Reconstruye la hoja y la raíz y rechaza formatos e índices inválidos.
 * Entradas. Prueba Merkle con fuente, clave, hoja, raíz, hermanos e índices.
 * Salida. Promesa de true si la hoja y la raíz coinciden, o false si no coinciden.
 */
export async function verifySourceProof(proof) {
  exactKeys(proof, PROOF_KEYS, "prueba Merkle");
  if (!Array.isArray(proof.merklePathElements) || !Array.isArray(proof.merklePathIndices) ||
      proof.merklePathElements.length !== MERKLE_DEPTH || proof.merklePathIndices.length !== MERKLE_DEPTH) {
    throw new TypeError(`La ruta Merkle debe contener exactamente ${MERKLE_DEPTH} niveles`);
  }
  const root = parseField(proof.root, "raíz");
  const source = await normalizeSource({ sourceId: proof.sourceId, publicKey: proof.publicKey });
  let current = await hashNormalizedSource(source);
  const leaf = parseField(proof.leaf, "hoja");
  if (current !== leaf) return false;
  for (let level = 0; level < MERKLE_DEPTH; level++) {
    const sibling = parseField(proof.merklePathElements[level], `hermano[${level}]`);
    const direction = parseField(proof.merklePathIndices[level], `índice[${level}]`, 2n);
    current = direction === 0n
      ? await poseidonHash([current, sibling])
      : await poseidonHash([sibling, current]);
  }
  return current === root;
}

/**
 * Incorpora una fuente nueva y devuelve otro conjunto canónico sin modificar el arreglo recibido.
 * Entradas. Conjunto actual y nueva fuente con identificador y clave pública.
 * Salida. Promesa de un arreglo ordenado e inmutable con la fuente agregada.
 */
export async function addAuthorizedSource(sources, entry) {
  const result = await normalizeSources(sources);
  const source = await normalizeSource(entry);
  if (findSourceIndex(result, source.sourceId) >= 0) throw new Error("La fuente ya está autorizada");
  if (result.length === MERKLE_CAPACITY) throw new RangeError(`El árbol admite hasta ${MERKLE_CAPACITY} fuentes`);
  result.push(source);
  result.sort(compareSources);
  return Object.freeze(result);
}

/**
 * Sustituye la clave de una fuente existente y devuelve un conjunto nuevo para reconstruir la raíz.
 * Entradas. Conjunto actual y fuente con su identificador y nueva clave pública.
 * Salida. Promesa de un arreglo inmutable con la clave sustituida.
 */
export async function updateAuthorizedSource(sources, entry) {
  const result = await normalizeSources(sources);
  const source = await normalizeSource(entry);
  const index = findSourceIndex(result, source.sourceId);
  if (index < 0) throw new Error("La fuente que se quiere actualizar no está autorizada");
  result[index] = source;
  return Object.freeze(result);
}

/**
 * Elimina una fuente existente del conjunto para reconstruir la raíz.
 * Entradas. Conjunto actual e identificador de la fuente revocada.
 * Salida. Promesa de un arreglo inmutable sin la fuente revocada.
 */
export async function revokeAuthorizedSource(sources, value) {
  const result = await normalizeSources(sources);
  const sourceId = normalizeSourceId(value);
  const index = findSourceIndex(result, sourceId);
  if (index < 0) throw new Error("La fuente que se quiere revocar no está autorizada");
  result.splice(index, 1);
  return Object.freeze(result);
}
