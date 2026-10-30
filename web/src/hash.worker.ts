/** Calcula la huella en un trabajador del navegador sin subir, recodificar ni acumular el archivo completo. */
import { hashContentStream } from "../../src/content-hash.mjs";

/** Entrega bloques de 64 KiB y publica los bytes que el algoritmo ya terminó de procesar. */
async function* chunks(file: File) {
  for (let offset = 0; offset < file.size; offset += 64 * 1024) {
    const bytes = new Uint8Array(await file.slice(offset, offset + 64 * 1024).arrayBuffer());
    yield bytes;
    self.postMessage({ type: "progress", processed: Math.min(offset + bytes.length, file.size), total: file.size });
  }
}

/** Atiende un archivo por trabajador y devuelve solamente su huella decimal o un error controlado. */
self.onmessage = async (event: MessageEvent<{ file: File }>) => {
  try {
    const file = event.data.file;
    const contentHash = await hashContentStream(chunks(file), BigInt(file.size));
    self.postMessage({ type: "result", contentHash: contentHash.toString() });
  } catch { self.postMessage({ type: "error" }); }
};
