/** Prepara el entorno web local o inicia la aplicación con un servicio de autorización expresamente configurado. */

import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { connectBlockchain } from "../src/blockchain.ts";
import { createApplication } from "../server/app.ts";
import { loadRuntime, initializeLocalRuntime } from "../server/runtime.ts";
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".png": "image/png", ".ico": "image/x-icon" };

/**
 * Inicia un único origen HTTP para la interfaz y la API.
 * Entradas. Indicador de modo de desarrollo.
 * Salida. Promesa sin valor. Inicia el servidor HTTP y, en desarrollo, Vite.
 */
async function serve(dev: boolean) {
  const port = Number(process.env.WEB_PORT || "5173");
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("WEB_PORT debe ser un puerto válido entre 1024 y 65535.");
  const origin = process.env.WEB_ORIGIN || "http://127.0.0.1:" + port;
  const connection = await connectBlockchain();
  const runtime = await loadRuntime(connection);
  if (runtime.experimental && new URL(origin).hostname !== "127.0.0.1") throw new Error("El firmante experimental solo admite el origen local 127.0.0.1.");
  const app = await createApplication(connection, runtime, origin, close);
  const applications = new Map<string, Promise<{ connection: typeof connection; app: typeof app }>>();
  applications.set(connection.networkName, Promise.resolve({ connection, app }));
  /**
   * Abre exclusivamente las redes configuradas y conserva su servicio y sus datos por separado.
   * Entradas. Nombre de la red solicitada.
   * Salida. Promesa del servicio de esa red y su conexión Hardhat.
   */
  async function applicationFor(name: string) {
    if (![connection.networkName, "localhost", "amoy"].includes(name)) throw new Error("Red no admitida");
    let pending = applications.get(name);
    if (!pending) {
      pending = (/* Inicializa el servicio de una red bajo demanda. Entradas. Sin argumentos. Usa el nombre de la red, el origen y el cierre del servicio. Salida. Promesa de una conexión y su aplicación. Si la aplicación falla, cierra la conexión. */ async () => { const selected = await connectBlockchain(name); try { return { connection: selected, app: await createApplication(selected, await loadRuntime(selected), origin, close) }; } catch (error) { await selected.close(); throw error; } })();
      applications.set(name, pending);
      pending.catch(/* Permite reintentar la conexión de una red que temporalmente no responde. Entradas. Ningún argumento utilizado. Salida. Booleano de Map.delete. Elimina la inicialización fallida de la caché. */ () => applications.delete(name));
    }
    return pending;
  }
  const staticRoot = path.resolve("web/dist");
  let vite: Awaited<ReturnType<(typeof import("vite"))["createServer"]>> | undefined;
  const server = createServer(/* Despacha solicitudes sin servir archivos privados fuera de web/dist. Entradas. Solicitud y respuesta HTTP. Salida. Promesa sin valor. Despacha la API de la red elegida o sirve la interfaz. */ async (request, response) => {
    try {
      response.setHeader("X-Frame-Options", "DENY");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'" + (dev ? " 'unsafe-inline'" : "") + "; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' ws://127.0.0.1:" + port + "; frame-ancestors 'none'");
      if (request.url?.startsWith("/api/") || request.url === "/rpc") {
        if (request.headers.host !== new URL(origin).host || request.headers.origin && request.headers.origin !== origin) { response.writeHead(403); response.end(); return; }
        const selected = request.headers["x-traza-network"];
        try { if (await (await applicationFor(typeof selected === "string" ? selected : connection.networkName)).app.handle(request, response)) return; }
        catch { response.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify({ error: { code: "NETWORK_UNAVAILABLE", message: "No se pudo conectar con la red seleccionada. Comprueba el RPC y vuelve a intentarlo." } })); return; }
      }
      if (vite) { vite.middlewares(request, response); return; }
      const pathname = decodeURIComponent(new URL(request.url ?? "/", origin).pathname);
      const candidate = path.resolve(staticRoot, "." + pathname);
      if (!candidate.startsWith(staticRoot + path.sep) && candidate !== staticRoot) { response.writeHead(403); response.end(); return; }
      const filename = pathname === "/" || !path.extname(pathname) ? path.join(staticRoot, "index.html") : candidate;
      const content = await readFile(filename);
      response.writeHead(200, { "Content-Type": MIME[path.extname(filename)] ?? "application/octet-stream", "Cache-Control": filename.endsWith("index.html") ? "no-cache" : "public, max-age=3600" });
      response.end(content);
    } catch { if (!response.headersSent) response.writeHead(404); response.end("Recurso no disponible"); }
  });
  if (dev) {
    const { createServer: createViteServer } = await import("vite");
    vite = await createViteServer({ configFile: path.resolve("vite.config.ts"), server: { middlewareMode: true, hmr: { server } }, appType: "spa" });
  } else if (!existsSync(path.join(staticRoot, "index.html"))) throw new Error("Falta el build web. Ejecuta npm run web:build.");
  server.listen(port, "127.0.0.1", /* Muestra solo la URL local y el modo efectivo del servicio. Entradas. Ningún argumento. Salida. Sin valor de retorno. Escribe el origen y el modo de operación en stdout. */ () => console.log("TRAZA: " + origin + (runtime.experimental ? " · Entorno experimental local" : "")));
  /**
   * Cierra HTTP, Vite, trabajos criptográficos y la conexión EVM de este proceso.
   * Entradas. Sin argumentos. Usa el servidor, Vite y las aplicaciones del cierre.
   * Salida. Promesa sin valor. Cierra los recursos abiertos por el servicio.
   */
  async function close() { server.closeAllConnections(); server.close(); await vite?.close(); for (const entry of applications.values()) { try { const item = await entry; await item.app.close(); await item.connection.close(); } catch { /* Una red que no abrió no conserva un servicio que cerrar. */ } } }
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

/**
 * Interpreta los comandos públicos del entorno web y mantiene las opciones de desarrollo explícitas.
 * Entradas. Sin argumentos. Lee el subcomando de process.argv.
 * Salida. Promesa sin valor. Ejecuta la preparación o inicia el servicio según el modo.
 */
async function run() {
  const command = process.argv[2];
  const { values } = parseArgs({ args: process.argv.slice(3), options: { experimental: { type: "boolean" }, registrant: { type: "string" }, help: { type: "boolean" } }, strict: true });
  if (command === "--help" || values.help) { console.log("Uso: web-cli <prepare|dev|start> [--experimental] [--registrant direccion]"); return; }
  if (command === "prepare") { if (!values.experimental) throw new Error("La preparación requiere --experimental."); const connection = await connectBlockchain("localhost"); try { await initializeLocalRuntime(connection, values.registrant ? [values.registrant] : []); } finally { await connection.close(); } }
  else if (command === "dev" || command === "start") await serve(command === "dev");
  else throw new Error("Comando web desconocido.");
}

try { await run(); } catch (error) { console.error("Error: " + (error instanceof Error ? error.message : "No se pudo iniciar el entorno web")); process.exitCode = 1; }
