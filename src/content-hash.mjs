/** Calcula Poseidon por bloques de bytes en Node y navegadores mediante una única implementación compartida. */

import { bytesToBigIntBE, parseField } from "./encoding.mjs";
import { getPoseidon } from "./poseidon.mjs";

// 31 bytes equivalen a 248 bits: cualquier bloque cabe en el campo sin reducción modular.
export const BLOCK_SIZE = 31;

/** Calcula la huella de fragmentos binarios ordenados, validando la longitud y usando un bloque de 31 bytes. */
export async function hashContentStream(chunks, fileLength) {
  const length = parseField(fileLength, "fileLength");
  const poseidon = await getPoseidon();
  const block = new Uint8Array(BLOCK_SIZE);
  let used = 0;
  let seen = 0n;
  // El primer Poseidon incorpora la longitud original junto con el primer bloque.
  let state = length;
  // Absorbe el bloque, incluido el relleno final con ceros, y limpia el búfer para el siguiente.
  const absorb = () => {
    state = poseidon.F.toObject(poseidon([state, bytesToBigIntBE(block)]));
    block.fill(0);
    used = 0;
  };
  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError("El stream debe emitir bytes Uint8Array");
    seen += BigInt(chunk.byteLength);
    if (seen > length) throw new RangeError("El stream excede fileLength");
    for (let offset = 0; offset < chunk.byteLength;) {
      const count = Math.min(BLOCK_SIZE - used, chunk.byteLength - offset);
      block.set(chunk.subarray(offset, offset + count), used);
      used += count;
      offset += count;
      if (used === BLOCK_SIZE) absorb();
    }
  }
  if (seen !== length) throw new RangeError("El stream no coincide con fileLength");
  // Procesa el último bloque parcial; para un archivo vacío se obtiene Poseidon(0, 0).
  if (used > 0 || length === 0n) absorb();
  return state;
}

/** Calcula contentHash de un Uint8Array reutilizando el mismo algoritmo de procesamiento por bloques. */
export async function hashContentBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Se requieren bytes Uint8Array");
  return hashContentStream([bytes], BigInt(bytes.byteLength));
}

