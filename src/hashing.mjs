/** Calcula la huella Poseidon de archivos multimedia y secuencias binarias en bloques de 31 bytes. */

import { open } from "node:fs/promises";
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

/** Lee los bytes exactos de un archivo por bloques y rechaza cambios detectados durante la lectura. */
export async function calculateContentHash(filePath) {
  const handle = await open(filePath, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new TypeError("La entrada debe ser un archivo regular");
    /** Entrega fragmentos del archivo con un búfer reutilizable de 64 KiB. */
    async function* chunks() {
      const buffer = new Uint8Array(64 * 1024);
      while (true) {
        const { bytesRead } = await handle.read(buffer);
        if (bytesRead === 0) break;
        yield buffer.subarray(0, bytesRead);
      }
    }
    const hash = await hashContentStream(chunks(), before.size);
    const after = await handle.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("El archivo cambió durante el cálculo de contentHash");
    }
    return hash;
  } finally {
    await handle.close();
  }
}
