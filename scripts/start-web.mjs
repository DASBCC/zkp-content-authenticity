/** Abre el navegador y prepara dependencias, artefactos y procesos locales sin pedir comandos al usuario. */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";

// El lanzador y la aplicación usan puertos distintos para mostrar el avance real de preparación.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
if (existsSync(".env")) loadEnvFile(".env");
const appUrl = "http://127.0.0.1:" + (process.env.WEB_PORT || "5173");
const launchPort = 5172;
const localRpc = process.env.RPC_URL || "http://127.0.0.1:8545";
let stage = "Comprobando la instalación";
let failure = false;
let ready = false;
let ownedNode;
let app;
let preparing = false;

/**
 * Comprueba una URL local con tiempo limitado sin asumir que un puerto abierto contiene esta aplicación.
 * Entradas. URL local que se quiere comprobar.
 * Salida. Promesa de true si la URL ofrece la API esperada, o false si falla la comprobación.
 */
async function available(url) {
  try { const response = await fetch(url + "/api/config", { signal: AbortSignal.timeout(1200) }); return response.ok && (await response.json()).rpcPath === "/rpc"; }
  catch { return false; }
}

/**
 * Abre la URL en el navegador predeterminado sin crear una ventana de consola visible.
 * Entradas. URL que debe abrir el navegador predeterminado.
 * Salida. Sin valor de retorno. Lanza la apertura de la URL.
 */
function openBrowser(url) {
  if (process.env.TRAZA_NO_BROWSER === "1") return;
  const opener = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true });
  opener.unref();
}

/**
 * Ejecuta una etapa conocida y conserva su diagnóstico en un archivo local excluido de Git.
 * Entradas. Etiqueta de la etapa y argumentos del proceso Node.
 * Salida. Promesa sin valor que se rechaza si el proceso falla.
 */
async function command(label, args) {
  stage = label;
  await new Promise(/* Controla la ejecución de una etapa del lanzador. Entradas. Funciones resolve y reject de la promesa. Salida. Sin valor de retorno. Inicia el proceso hijo y enlaza sus eventos al resultado. */ (resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    /**
     * Guarda salida de herramientas sin imprimir variables de entorno ni claves del nodo.
     * Entradas. Fragmento de stdout o stderr del proceso hijo.
     * Salida. Sin valor de retorno. Añade el fragmento al archivo de diagnóstico.
     */
    function record(chunk) { void appendFile(path.join(root, ".local-web/startup.log"), chunk).catch(/* El diagnóstico no debe detener una etapa correcta. Entradas. Ningún argumento utilizado. Salida. undefined. */ () => undefined); }
    child.stdout.on("data", record); child.stderr.on("data", record);
    child.once("error", reject);
    child.once("exit", /* Propaga el resultado real de la herramienta ejecutada. Entradas. Código de salida del proceso hijo. Salida. Sin valor de retorno. Resuelve si el código es cero o rechaza con un error de etapa. */ (code) => code === 0 ? resolve() : reject(new Error(label + " terminó con código " + code)));
  });
}

/**
 * Espera el RPC local sin iniciar ni modificar redes externas.
 * Entradas. Sin argumentos. Usa la URL del nodo de desarrollo.
 * Salida. Promesa de true si el RPC devuelve el identificador de cadena configurado, o false en otro caso.
 */
async function nodeReady() {
  try { const response = await fetch(localRpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(1000) }); return BigInt((await response.json()).result) === BigInt(process.env.CHAIN_ID || "31337"); }
  catch { return false; }
}

/**
 * Cierra el servidor auxiliar y los procesos que inició el lanzador.
 * Entradas. Sin argumentos. Usa el nodo y la aplicación gestionados por el lanzador.
 * Salida. Sin valor de retorno. Solicita el cierre de los procesos propios.
 */
function close() { app?.kill(); ownedNode?.kill(); server.close(); }

const server = createServer(/* Muestra el avance de herramientas reales y permite reintentar abriendo nuevamente el lanzador. Entradas. Solicitud y respuesta HTTP. Salida. Sin valor de retorno. Responde con estado, pantalla inicial o resultado del reintento. */ (request, response) => {
  if (request.url === "/retry" && request.method === "POST") {
    if (request.headers.host !== "127.0.0.1:" + launchPort || request.headers.origin !== "http://127.0.0.1:" + launchPort || preparing) { response.writeHead(403); response.end(); return; }
    failure = false; void prepare().catch(failed);
    response.writeHead(202); response.end(); return;
  }
  if (request.url === "/status") { response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify({ stage, failure, ready, url: appUrl })); return; }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" });
  // El sondeo del navegador consulta el estado. Sin argumentos. Devuelve una promesa sin valor, actualiza la pantalla y redirige cuando la app está lista.
  // El clic de reintento solicita reiniciar la preparación. Sin argumentos utilizados ni valor de retorno. Envía un POST a /retry.
  response.end(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Abriendo Traza</title><style>body{margin:0;background:#f4f6f1;font:17px system-ui;color:#173e35;display:grid;place-items:center;min-height:100vh}main{max-width:550px;padding:45px}small{letter-spacing:.22em}h1{font-size:48px;line-height:1.1}p{color:#596b63;line-height:1.7}i{display:block;width:36px;height:36px;border:3px solid #d4e4d7;border-top-color:#276c58;border-radius:50%;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style><main><small>TRAZA / AUTENTICIDAD MULTIMEDIA</small><h1>Preparando tu espacio.</h1><i></i><p id="state">Comprobando la instalación…</p><p>La primera apertura prepara las herramientas criptográficas. Mantén esta ventana abierta; entrarás al sitio cuando termine.</p><button id="retry" hidden onclick="fetch('/retry',{method:'POST'})" style="background:#214f40;color:white;border:0;padding:13px 20px;border-radius:6px;cursor:pointer">Reintentar preparación</button></main><script>setInterval(async()=>{try{const r=await fetch('/status');const s=await r.json();document.getElementById('state').textContent=s.stage;document.querySelector('i').style.display=s.failure?'none':'block';document.getElementById('retry').hidden=!s.failure;if(s.ready)location.replace(s.url)}catch{}},800)</script></html>`);
});

/**
 * Prepara la infraestructura y entrega al usuario una aplicación local que conserva el nodo mientras está en uso.
 * Entradas. Sin argumentos. Usa la configuración local del lanzador.
 * Salida. Promesa sin valor. Reutiliza la aplicación disponible o inicia la pantalla de preparación.
 */
async function start() {
  if (await available(appUrl)) { openBrowser(appUrl); return; }
  await mkdir(path.join(root, ".local-web"), { recursive: true });
  await new Promise(/* Escucha solo en loopback antes de abrir la pantalla de preparación. Entradas. Funciones resolve y reject de la promesa. Salida. Sin valor de retorno. Inicia la escucha y enlaza su resultado con la promesa. */ (resolve, reject) => { server.once("error", reject); server.listen(launchPort, "127.0.0.1", resolve); });
  openBrowser("http://127.0.0.1:" + launchPort);
  await prepare();
}

/**
 * Prepara las herramientas y servicios que necesita la aplicación local.
 * Entradas. Sin argumentos. Usa las rutas, el servidor y el estado de la preparación.
 * Salida. Promesa sin valor. Prepara las herramientas e inicia el servidor web.
 */
async function prepare() {
  preparing = true;
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  if (!existsSync(path.join(root, "node_modules/vite/package.json")) || !existsSync(path.join(root, "node_modules/react/package.json"))) {
    if (!existsSync(npmCli)) throw new Error("No se encontró npm junto a Node.js. Reinstala Node.js y vuelve a abrir Traza.");
    await command("Instalando las dependencias del proyecto", [npmCli, "ci", "--no-audit"]);
  }
  await command("Preparando y comprobando los artefactos Groth16", ["scripts/zk-cli.mjs", "setup"]);
  await command("Construyendo contratos y aplicación web", [npmCli, "run", "build"]);
  if (!process.env.BLOCKCHAIN_NETWORK || process.env.BLOCKCHAIN_NETWORK === "localhost") {
    if (!await nodeReady()) {
      stage = "Iniciando blockchain local";
      const endpoint = new URL(localRpc);
      if (!["127.0.0.1", "localhost"].includes(endpoint.hostname) || (process.env.CHAIN_ID && process.env.CHAIN_ID !== "31337")) throw new Error("El inicio automático requiere un RPC local de la cadena 31337.");
      ownedNode = spawn(process.execPath, ["node_modules/hardhat/dist/src/cli.js", "node", "--network", "hardhatMainnet", "--hostname", "127.0.0.1", "--port", endpoint.port || "8545"], { cwd: root, windowsHide: true, stdio: "ignore" });
      for (let count = 0; count < 80 && !await nodeReady(); count++) await new Promise(/* Espera asíncrona de la disponibilidad real del nodo. Entradas. Función resolve de la promesa. Salida. Sin valor útil. Programa resolve después de 200 ms. */ (resolve) => setTimeout(resolve, 200));
      if (!await nodeReady()) throw new Error("No se pudo iniciar el nodo local. Comprueba que el puerto 8545 esté disponible.");
    }
  }
  stage = "Iniciando la aplicación";
  app = spawn(process.execPath, ["--import", "tsx", "scripts/web-cli.ts", "start"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  app.stderr.on("data", /* Conserva únicamente el diagnóstico operativo del servicio. Entradas. Fragmento de stderr del proceso web. Salida. Sin valor de retorno. Agrega el fragmento al log de arranque. */ (chunk) => { void appendFile(path.join(root, ".local-web/startup.log"), chunk); });
  app.once("exit", /* Conserva la recuperación si el servicio falla antes de estar listo. Entradas. Ningún argumento utilizado. Salida. Sin valor de retorno. Cierra la infraestructura propia si el servicio llegó a estar listo. */ () => { if (ready) close(); });
  for (let count = 0; count < 80 && !await available(appUrl); count++) await new Promise(/* Espera la configuración publicada por el servicio real. Entradas. Función resolve de la promesa. Salida. Sin valor útil. Programa resolve después de 200 ms. */ (resolve) => setTimeout(resolve, 200));
  if (!await available(appUrl)) throw new Error("La aplicación no pudo iniciar. Revisa .local-web/startup.log.");
  ready = true;
  stage = "Listo";
  setTimeout(/* Deja que la pantalla inicial redirija y libera su puerto auxiliar. Entradas. Ningún argumento. Salida. Devuelve el resultado de server.close() e inicia el cierre del servidor auxiliar. */ () => server.close(), 4000);

  preparing = false;
}

/**
 * Conserva el diagnóstico de una etapa fallida y permite repetirla desde el navegador.
 * Entradas. Error de la etapa de preparación.
 * Salida. Sin valor de retorno. Actualiza el estado visible y detiene los procesos propios.
 */
function failed(error) { failure = true; preparing = false; stage = error.message; app?.kill(); ownedNode?.kill(); }
try { await start(); } catch (error) { failed(error); }
process.once("SIGINT", close);
process.once("SIGTERM", close);
