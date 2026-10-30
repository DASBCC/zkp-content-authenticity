/** Lee archivos locales de forma estable y reutiliza la misma huella Poseidon que utiliza el navegador. */

import { open } from "node:fs/promises";
import { hashContentStream } from "./content-hash.mjs";
export { BLOCK_SIZE, hashContentStream, hashContentBytes } from "./content-hash.mjs";

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
