import fs from "node:fs/promises";
import { buildPoseidon } from "circomlibjs";

const BLOCK_SIZE = 31;

function blockToBigInt(block) {
  const padded = Buffer.alloc(BLOCK_SIZE);

  // Copia los bytes originales al inicio.
  // El resto queda rellenado con 0x00 a la derecha.
  block.copy(padded);

  return BigInt("0x" + padded.toString("hex"));
}

export async function calculateContentHash(filePath) {
  const file = await fs.readFile(filePath);

  if (file.length === 0) {
    throw new Error("El archivo no puede estar vacío.");
  }

  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const blocks = [];

  for (let offset = 0; offset < file.length; offset += BLOCK_SIZE) {
    const block = file.subarray(offset, offset + BLOCK_SIZE);
    blocks.push(blockToBigInt(block));
  }

  // Primer valor:
  // h0 = Poseidon(longitud, bloque0)
  let hash = poseidon([
    BigInt(file.length),
    blocks[0],
  ]);

  // Bloques restantes:
  // hi = Poseidon(hashAnterior, bloqueActual)
  for (let i = 1; i < blocks.length; i++) {
    const previousHash = F.toObject(hash);

    hash = poseidon([
      previousHash,
      blocks[i],
    ]);
  }

  return F.toObject(hash).toString();
}