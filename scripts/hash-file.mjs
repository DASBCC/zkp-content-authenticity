import { calculateContentHash } from "../src/hash/poseidon.mjs";

const filePath = process.argv[2];

if (!filePath) {
  console.error("Uso: node scripts/hash-file.mjs <archivo>");
  process.exit(1);
}

try {
  const hash = await calculateContentHash(filePath);

  console.log("Archivo:", filePath);
  console.log("contentHash:", hash);
} catch (error) {
  console.error("Error:", error.message);
  process.exit(1);
}