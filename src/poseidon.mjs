/** Centraliza la creación y el uso de Poseidon para reutilizar una única instancia de circomlibjs. */

import { buildPoseidon } from "circomlibjs";
import { parseField } from "./encoding.mjs";

// Comparte también la inicialización en curso cuando varias llamadas solicitan Poseidon a la vez.
let instance;
/** Construye Poseidon de circomlibjs una sola vez y comparte su promesa entre las llamadas. */
export function getPoseidon() {
  instance ??= buildPoseidon();
  return instance;
}

/** Calcula Poseidon para entre 1 y 16 elementos de campo validados y devuelve un BigInt. */
export async function poseidonHash(inputs) {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 16) {
    throw new TypeError("Poseidon requiere entre 1 y 16 elementos de campo");
  }
  const values = inputs.map(/* Valida cada entrada y la convierte a BigInt. */ (value, index) => parseField(value, `inputs[${index}]`));
  const poseidon = await getPoseidon();
  return poseidon.F.toObject(poseidon(values));
}
