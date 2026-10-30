/** Inicia una cadena y un servicio exclusivos de E2E para no alterar los contratos o fuentes del usuario. */
import { spawn } from "node:child_process";
import path from "node:path";
import { mkdir } from "node:fs/promises";

// Los puertos y el directorio son exclusivos de la prueba y están separados del lanzador del usuario.
const nodePort = 18545;
const webPort = 5174;
const data = path.resolve(".crypto-build/web-e2e-" + process.pid);
await mkdir(data, { recursive: true });
const node = spawn(process.execPath, ["node_modules/hardhat/dist/src/cli.js", "node", "--network", "hardhatMainnet", "--port", String(nodePort), "--hostname", "127.0.0.1"], { windowsHide: true, stdio: "ignore" });
let app;

/** Detiene solo los procesos hijos creados para esta prueba. */
function close() { app?.kill(); node.kill(); }
process.once("SIGINT", close); process.once("SIGTERM", close); process.once("exit", close);

for (let count = 0; count < 100; count++) {
  try { const result = await fetch("http://127.0.0.1:" + nodePort, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) }); if ((await result.json()).result === "0x7a69") break; } catch { /* El nodo todavía no terminó de iniciar. */ }
  if (count === 99) throw new Error("El nodo E2E no inició");
  await new Promise(/* Espera disponibilidad del nodo sin bloquear la preparación de otras tareas. */ (resolve) => setTimeout(resolve, 100));
}
app = spawn(process.execPath, ["--import", "tsx", "scripts/web-cli.ts", "start"], { windowsHide: true, stdio: "inherit", env: { ...process.env, BLOCKCHAIN_NETWORK: "localhost", RPC_URL: "http://127.0.0.1:" + nodePort, CHAIN_ID: "31337", WEB_PORT: String(webPort), WEB_ORIGIN: "http://127.0.0.1:" + webPort, WEB_DATA_DIRECTORY: data, WEB_DEPLOYMENT_FILE: "", WEB_SIGNING_ENABLED: "false", REGISTRY_ADDRESS: "", VERIFIER_ADDRESS: "" } });
app.once("exit", /* Cierra el nodo aislado cuando termina el servicio del ensayo. */ (code) => { close(); process.exitCode = code ?? 0; });
