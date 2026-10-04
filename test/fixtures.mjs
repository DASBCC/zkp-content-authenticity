/** Reúne datos de ensayo reproducibles y utilidades compartidas para las pruebas criptográficas. */

import { readFile, mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { privateKeyFromHex } from "../src/key-management.mjs";

// Valores deterministas de ensayo; su semilla es pública y no debe usarse para autorizar contenido real.
export const vector = JSON.parse(await readFile(new URL("./vectors/crypto-v1.json", import.meta.url), "utf8"));
/** Devuelve una copia de la semilla pública de ensayo para que cada prueba tenga sus propios bytes. */
export const testSeed = () => privateKeyFromHex(vector.testOnlyPrivateSeedHex);
/** Genera una secuencia binaria reproducible que repite los valores 0 a 255. */
export const bytes = (length) => Uint8Array.from({ length }, /* Repite los valores de octeto 0 a 255 según la posición. */ (_value, index) => index % 256);
/** Crea una carpeta de ensayo única dentro de .crypto-build, que está excluida de Git. */
export async function temporaryDirectory(prefix) {
  const root = resolve(".crypto-build");
  await mkdir(root, { recursive: true });
  return mkdtemp(resolve(root, prefix));
}
