/** Firma y genera Groth16 en un trabajador de confianza; nunca envía firma EdDSA, identidad ni testigo al navegador. */


import { readFile } from "node:fs/promises";
import { loadPrivateKey } from "../src/key-management.mjs";
import { signContentAuthorization } from "../src/authorization.mjs";
import { buildAuthorizedSourcesTree, getSourceProof } from "../src/merkle.mjs";
import { generateNonce } from "../src/protocol.mjs";
import { createProofInputs, generateProof } from "../src/zkp.mjs";

/** Publica únicamente el nombre de una etapa que realmente comienza a ejecutarse. */
function stage(value) { process.send({ type: "stage", stage: value }); }

/** Ejecuta la autorización aprobada y limpia la copia administrada de la semilla al terminar. */
async function run(workerData) {
  let seed;
  try {
    stage("authorizing");
    const { sourceKeyFile, sourcesFile, sourceId, operation, expectedRoot } = workerData;
    seed = await loadPrivateKey({ filePath: sourceKeyFile, env: {} });
    const tree = await buildAuthorizedSourcesTree(JSON.parse(await readFile(sourcesFile, "utf8")));
    if (tree.root.toString() !== expectedRoot) throw new Error("ROOT_CHANGED");
    const authorization = await signContentAuthorization({ ...operation, sourceId, nonce: generateNonce() }, seed);
    stage("authorized");
    const membership = await getSourceProof(tree, sourceId);
    const inputs = await createProofInputs(authorization, membership);
    const result = await generateProof(inputs, { onProgress: stage });
    process.send({ type: "result", result });
  } catch (error) {
    // Los mensajes del proveedor o de Circom pueden contener entradas; solo sale una clasificación controlada.
    process.send({ type: "error", code: error.message === "ROOT_CHANGED" ? "ROOT_CHANGED" : "PROOF_FAILED" });
  } finally { seed?.fill(0); }
}

process.once("message", run);
