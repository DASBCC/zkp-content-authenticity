/** Ejecuta compilación y suites reales desde Administración sin requerir una terminal y con resultados limitados al propietario. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { chromium } from "@playwright/test";
import { capability, ServiceError } from "./security.ts";

/**
 * Mantiene un único ensayo completo activo y no transmite salidas internas de pruebas al navegador.
 * Entradas. Ningún argumento.
 * Salida. Controlador con operaciones para iniciar, consultar y cerrar una validación.
 */
export function createValidationRunner() {
  let job: { id: string; token: string; stage: string; status: string; checks: { name: string; passed: boolean; summary: string }[]; error?: string; expires: number } | undefined;
  let child: ReturnType<typeof spawn> | undefined;

  /**
   * Ejecuta una herramienta conocida y extrae solo su resumen público de aprobación.
   * Entradas. Nombre público de la etapa y argumentos del proceso Node.
   * Salida. Promesa sin valor. Actualiza el resumen del trabajo y se rechaza ante un fallo.
   */
  async function step(name: string, args: string[]) {
    if (!job) return;
    job.stage = name;
    const log = path.resolve(".local-web", "validation-" + job.id + ".log");
    await mkdir(path.dirname(log), { recursive: true });
    let tail = "";
    const passed = await new Promise<boolean>(/* Espera la salida real de una herramienta ejecutada fuera de la API. Entradas. Función resolve de la promesa booleana. Salida. Sin valor de retorno. Inicia el proceso hijo y suscribe los manejadores. */ (resolve) => {
      child = spawn(process.execPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      /**
       * Conserva el diagnóstico en un archivo privado y limita el texto usado para reconocer el resumen.
       * Entradas. Fragmento de salida del proceso hijo.
       * Salida. Sin valor de retorno. Actualiza el resumen de salida y agrega el fragmento al log.
       */
      function record(chunk: Buffer) { tail = (tail + chunk.toString()).slice(-20_000); void appendFile(log, chunk).catch(/* La falta de un log no cambia el resultado de la prueba. Entradas. Ningún argumento utilizado. Salida. undefined. */ () => undefined); }
      child.stdout?.on("data", record); child.stderr?.on("data", record);
      child.once("error", /* Marca una falla de ejecución sin mostrar variables o argumentos del proceso. Entradas. Ningún argumento utilizado. Salida. Sin valor de retorno. Resuelve la comprobación como fallida. */ () => resolve(false));
      child.once("exit", /* Usa el código real de la herramienta como criterio de aprobación. Entradas. Código de salida del proceso o null. Salida. Sin valor de retorno. Resuelve con true solo para código cero. */ (code) => resolve(code === 0));
    });
    const summary = tail.replace(/\u001b\[[0-9;]*m/g, "").match(/\d+ passing[^\n]*|\d+ passed[^\n]*/)?.[0] ?? (passed ? "Comprobación completada" : "La herramienta informó un fallo");
    job.checks.push({ name, passed, summary });
    if (!passed) throw new Error("Falló: " + name + ". Revisa el diagnóstico local validation-" + job.id + ".log.");
  }

  /**
   * Inicia una validación sin simular porcentajes y conserva únicamente su estado público en memoria.
   * Entradas. Sin argumentos. Usa el estado de validación de esta instancia.
   * Salida. Identificador del nuevo trabajo y token de consulta.
   */
  function start() {
    if (job?.status === "running") throw new ServiceError("BUSY", "Ya hay una validación en curso.", 409);
    job = { id: randomUUID(), token: capability(), stage: "Iniciando comprobación", status: "running", checks: [], expires: Date.now() + 3_600_000 };
    /**
     * Encadena compilación, contratos y navegador reales, con una infraestructura E2E independiente.
     * Entradas. Sin argumentos. Usa el trabajo activo del cierre.
     * Salida. Promesa sin valor. Guarda el resultado de la ejecución en el trabajo.
     */
    async function run() {
      try {
        const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
        await step("Construcción de producción", [npmCli, "run", "build"]);
        await step("Contratos y módulos criptográficos", ["node_modules/hardhat/dist/src/cli.js", "test"]);
        if (!existsSync(chromium.executablePath())) await step("Preparación del navegador de pruebas", ["node_modules/@playwright/test/cli.js", "install", "chromium"]);
        await step("Recorrido completo en navegador", ["node_modules/@playwright/test/cli.js", "test"]);
        if (job) { job.status = "passed"; job.stage = "Todas las comprobaciones aprobaron"; }
      } catch (error) { if (job) { job.status = "failed"; job.error = error instanceof Error ? error.message : "La validación no terminó."; } }
      finally { child = undefined; }
    }
    void run();
    return { jobId: job.id, jobToken: job.token };
  }

  /**
   * Restringe el resultado al token entregado al administrador que inició este ensayo.
   * Entradas. Identificador de validación y encabezado Authorization.
   * Salida. Estado, etapa, comprobaciones y error público, si existe.
   */
  function read(id: string, authorization: string | undefined) {
    if (!job || job.id !== id || job.expires < Date.now() || authorization !== "Bearer " + job.token) throw new ServiceError("NOT_FOUND", "No se encontró la validación o venció su acceso.", 404);
    return { status: job.status, stage: job.stage, checks: job.checks, error: job.error };
  }

  /**
   * Detiene el proceso de validación que pertenece a esta instancia del servicio.
   * Entradas. Sin argumentos. Usa el proceso hijo en curso.
   * Salida. Sin valor de retorno. Solicita la terminación del proceso si existe.
   */
  function close() { child?.kill(); }
  return { start, read, close };
}
