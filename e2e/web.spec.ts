/** Ejecuta la aplicación real desde Chromium hasta Groth16 y la blockchain, sin reemplazar firmas ni contratos. */
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { calculateContentHash } from "../src/hashing.mjs";

test.describe.configure({ mode: "serial" });
let expectedHash: string;

/**
 * Comprueba la preparación sin comandos y el registro de una imagen real desde los controles de la web.
 * Entradas. Fixture page de Playwright y archivo de imagen de ejemplo.
 * Salida. Promesa sin valor. Guarda la huella de referencia y una captura del registro confirmado.
 */
test("prepara el sistema, genera Groth16 y registra una imagen desde el sitio", async ({ page }) => {
  expectedHash = (await calculateContentHash("samples/imagen-prueba.svg")).toString();
  const errors: string[] = [];
  page.on("pageerror", /* Conserva errores de ejecución para impedir que una pantalla aparentemente correcta los oculte. Entradas. Error emitido por la página. Salida. Longitud de la lista tras agregar el mensaje del error. */ (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Cada archivo. Una traza verificable." })).toBeVisible();
  await page.getByRole("button", { name: "Usar cuenta experimental" }).click();
  await expect(page.getByRole("button", { name: /0xf39/ })).toBeVisible();
  await page.getByRole("link", { name: "Administración", exact: true }).click();
  await page.getByRole("checkbox", { name: /Habilitar el entorno experimental/ }).check();
  await page.getByRole("button", { name: "Preparar sistema local" }).click();
  await expect(page.getByText("Sistema preparado. Ya puedes registrar y verificar archivos desde el sitio.")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("link", { name: "Registrar contenido", exact: true }).click();
  await page.getByLabel("Seleccionar archivo multimedia", { exact: true }).setInputFiles(path.resolve("samples/imagen-prueba.svg"));
  await expect(page.getByText(expectedHash, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Preparar prueba" }).click();
  await expect(page.getByRole("button", { name: "Confirmar registro" })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole("button", { name: "Confirmar registro" }).click();
  await expect(page.getByRole("heading", { name: "Registro encontrado" })).toBeVisible({ timeout: 30_000 });
  await page.getByText("Prueba pública y métricas", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Descargar comprobante" })).toBeVisible();
  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/registro-confirmado.png", fullPage: true });
});

/**
 * Recalcula la imagen original sin wallet, comprueba una alteración y distingue una falla RPC de un resultado negativo.
 * Entradas. Fixture page, imagen de ejemplo y huella registrada en la prueba anterior.
 * Salida. Promesa sin valor. Comprueba la consulta positiva, la negativa y el error RPC.
 */
test("consulta sin wallet, rechaza bytes modificados y muestra errores operativos separados", async ({ page }) => {
  await page.goto("/#verificar");
  await expect(page.getByRole("button", { name: "Conectar wallet" })).toBeVisible();
  await page.getByLabel("Seleccionar archivo multimedia", { exact: true }).setInputFiles(path.resolve("samples/imagen-prueba.svg"));
  await expect(page.getByRole("heading", { name: "Registro encontrado" })).toBeVisible();
  await expect(page.getByText(expectedHash, { exact: true })).toBeVisible();
  const original = await readFile("samples/imagen-prueba.svg", "utf8");
  await page.getByLabel("Seleccionar archivo multimedia", { exact: true }).setInputFiles({ name: "imagen-modificada.svg", mimeType: "image/svg+xml", buffer: Buffer.from(original.replace("#e7eee0", "#e7eee1")) });
  await expect(page.getByRole("heading", { name: "Sin registro", exact: true })).toBeVisible();
  await page.route("**/rpc", /* Simula únicamente una caída de red para comprobar la clasificación visual del error. Entradas. Ruta RPC interceptada por Playwright. Salida. Promesa sin valor de abortar la petición. */ (route) => route.abort());
  await page.getByLabel("Seleccionar archivo multimedia", { exact: true }).setInputFiles(path.resolve("samples/imagen-prueba.svg"));
  await expect(page.getByRole("alert")).toContainText("No se pudo consultar la blockchain");
  await expect(page.getByRole("heading", { name: "Sin registro", exact: true })).toHaveCount(0);
});

/**
 * Comprueba el rechazo de contenido duplicado desde el flujo de autorización visible.
 * Entradas. Fixture page y el archivo ya registrado.
 * Salida. Promesa sin valor. Comprueba el aviso de duplicado y la ausencia del botón de confirmación.
 */
test("rechaza un registro duplicado antes de solicitar otra transacción", async ({ page }) => {
  await page.goto("/#registrar");
  await page.getByRole("button", { name: "Usar cuenta experimental" }).click();
  await expect(page.getByRole("button", { name: /0xf39/ })).toBeVisible();
  await page.getByLabel("Seleccionar archivo multimedia", { exact: true }).setInputFiles(path.resolve("samples/imagen-prueba.svg"));
  await page.getByRole("button", { name: "Preparar prueba" }).click();
  await expect(page.getByRole("alert")).toContainText("ya tiene un registro");
  await expect(page.getByRole("button", { name: "Confirmar registro" })).toHaveCount(0);
});

/**
 * Prueba gas explícito en las tres etapas y recuperación tras un rechazo con contratos ejecutados en la EVM.
 * Entradas. Fixture page y cuenta experimental.
 * Salida. Promesa sin valor. Comprueba el gas, la recuperación y el registro en el nuevo contrato.
 */
test("despliega ambos contratos desde la wallet y recupera un despliegue interrumpido", async ({ page }) => {
  await page.goto("/#administracion");
  await page.getByRole("button", { name: "Usar cuenta experimental" }).click();
  await expect(page.getByRole("button", { name: /0xf39/ })).toBeVisible();
  await page.getByText("Nuevo despliegue firmado por mi wallet", { exact: true }).click();
  await page.getByLabel("Usar una fuente de desarrollo y el setup experimental").check();
  const before = await (await page.request.get("/api/config")).json();
  let creations = 0;
  const gasLimits: bigint[] = [];
  await page.route("**/api/local-wallet/request", /* Reproduce una wallet que rechaza gas ausente o excesivo y un rechazo manual; el resto llega a la EVM real. Entradas. Petición de la wallet interceptada. Salida. Promesa sin valor. Responde con un rechazo simulado o continúa la petición real. */ async (route) => {
    const value = route.request().postDataJSON();
    if (value.method === "eth_sendTransaction") {
      const gas = value.params?.[0]?.gas;
      if (!gas || BigInt(gas) > 16_777_216n) { await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { code: "GAS_LIMIT_EXCEEDED", message: "La wallet rechazó un límite de gas ausente o excesivo." } }) }); return; }
      gasLimits.push(BigInt(gas));
    }
    if (value.method === "eth_sendTransaction" && !value.params?.[0]?.to) {
      creations++;
      if (creations === 2) { await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { code: "USER_REJECTED", message: "Transacción rechazada en la wallet de ensayo." } }) }); return; }
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Desplegar contratos con mi wallet" }).click();
  await expect(page.getByRole("alert")).toContainText("rechazada");
  await page.getByRole("button", { name: "Continuar despliegue" }).click();
  await expect(page.getByText("Despliegue confirmado y conectado al sitio.")).toBeVisible({ timeout: 30_000 });
  expect(creations).toBe(3);
  expect(gasLimits).toHaveLength(4);
  expect(gasLimits.every(/* Exige estimaciones pequeñas y positivas, independientes del límite global del bloque. Entradas. Límite de gas enviado por una transacción. Salida. true si es positivo y menor que 16 777 216. */ (gas) => gas > 0n && gas < 16_777_216n)).toBe(true);
  const after = await (await page.request.get("/api/config")).json();
  expect(after.registryAddress).not.toBe(before.registryAddress);
  await page.getByRole("link", { name: "Registrar contenido", exact: true }).click();
  await page.getByLabel("Seleccionar archivo multimedia", { exact: true }).setInputFiles(path.resolve("samples/imagen-prueba.svg"));
  await page.getByRole("button", { name: "Preparar prueba" }).click();
  await expect(page.getByRole("button", { name: "Confirmar registro" })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole("button", { name: "Confirmar registro" }).click();
  await expect(page.getByRole("heading", { name: "Registro encontrado" })).toBeVisible();
  expect(gasLimits).toHaveLength(5);
});

/**
 * Comprueba la recuperación del contexto local al seleccionar una red externa temporalmente indisponible.
 * Entradas. Fixture page y despliegue local vigente.
 * Salida. Promesa sin valor. Comprueba el error de Amoy y la conservación del registro local.
 */
test("el selector conserva los despliegues y distingue una falla de conexión de Amoy", async ({ page }) => {
  await page.goto("/");
  const before = await (await page.request.get("/api/config")).json();
  await page.route("**/api/config", /* Simula únicamente una indisponibilidad RPC; no inventa contratos ni resultados de Amoy. Entradas. Petición de configuración interceptada. Salida. Promesa sin valor. Devuelve 503 para Amoy o continúa la consulta. */ async (route) => {
    if (route.request().headers()["x-traza-network"] === "amoy") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "NETWORK_UNAVAILABLE", message: "Amoy temporalmente no disponible" } }) });
    else await route.continue();
  });
  await page.getByLabel("Red del protocolo", { exact: true }).selectOption("amoy");
  await expect(page.getByRole("alert")).toContainText("Amoy temporalmente no disponible");
  await page.getByLabel("Red del protocolo", { exact: true }).selectOption("localhost");
  await expect(page.getByRole("heading", { name: "Cada archivo. Una traza verificable." })).toBeVisible();
  const after = await (await page.request.get("/api/config")).json();
  expect(after.registryAddress).toBe(before.registryAddress);
});
/**
 * Comprueba administración autenticada, alta y revocación reales, y el bloqueo de emisión por política.
 * Entradas. Fixture page y wallet administradora local.
 * Salida. Promesa sin valor. Comprueba los cambios de fuentes y la política de emisión.
 */
test("administra fuentes y permisos íntegramente desde la interfaz", async ({ page }) => {
  await page.goto("/#administracion");
  await expect(page.getByLabel("Importar un conjunto JSON")).toHaveCount(0);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Usar cuenta experimental" }).click();
  await expect(page.getByRole("button", { name: /0xf39/ })).toBeVisible();
  await page.getByRole("button", { name: "Acceder al conjunto privado" }).click();
  await expect(page.getByText("Fuente 1", { exact: true })).toBeVisible();
  await page.locator(".source-row").filter({ hasText: "Fuente 1" }).getByRole("button", { name: "Rotar" }).click();
  await page.getByRole("button", { name: "Publicar y sincronizar conjunto" }).click();
  await expect(page.getByText("Raíz confirmada y conjunto sincronizado.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Acceder al conjunto privado" }).click();
  await page.getByLabel("Identificador de nueva fuente").fill("2");
  await page.getByRole("button", { name: "Crear fuente", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Revisa la nueva raíz" })).toBeVisible();
  await page.getByRole("button", { name: "Publicar y sincronizar conjunto" }).click();
  await expect(page.getByText("Raíz confirmada y conjunto sincronizado.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Acceder al conjunto privado" }).click();
  await expect(page.getByText("Fuente 2", { exact: true })).toBeVisible();
  await page.locator(".source-row").filter({ hasText: "Fuente 2" }).getByRole("button", { name: "Revocar" }).click();
  await page.getByRole("button", { name: "Publicar y sincronizar conjunto" }).click();
  await expect(page.getByText("Raíz confirmada y conjunto sincronizado.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Acceder al conjunto privado" }).click();
  await expect(page.getByText("Fuente 2", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: "test-results/administracion-sin-importacion.png", fullPage: true });
  await page.getByLabel("Permitir solicitudes de autorización").uncheck();
  await page.getByRole("button", { name: "Guardar permisos" }).click();
  await expect(page.getByText("Permisos de emisión actualizados.")).toBeVisible();
  await page.getByRole("link", { name: "Registrar contenido", exact: true }).click();
  await page.getByLabel("Seleccionar archivo multimedia", { exact: true }).setInputFiles(path.resolve("samples/imagen-prueba.svg"));
  await expect(page.getByRole("button", { name: "Preparar prueba" })).toBeDisabled();
});

/**
 * Comprueba que otra cuenta de laboratorio no obtiene autorizaciones ni controles administrativos.
 * Entradas. Fixture page y una cuenta sin permiso de registro.
 * Salida. Promesa sin valor. Comprueba que la interfaz muestra el rechazo de autorización.
 */
test("una cuenta sin permiso no puede obtener una firma de fuente desde la web", async ({ page }) => {
  await page.goto("/#administracion");
  await page.getByRole("button", { name: "Usar cuenta experimental" }).click();
  await expect(page.getByRole("button", { name: /0xf39/ })).toBeVisible();
  await page.getByRole("button", { name: "Acceder al conjunto privado" }).click();
  await page.getByLabel("Permitir solicitudes de autorización").check();
  await page.getByRole("button", { name: "Guardar permisos" }).click();
  await expect(page.getByText("Permisos de emisión actualizados.")).toBeVisible();
  await page.getByLabel("Cuenta experimental local", { exact: true }).selectOption({ index: 1 });
  await expect(page.getByRole("button", { name: "Acceder al conjunto privado" })).toBeDisabled();
  await expect(page.getByText("Fuente 1", { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Registrar contenido", exact: true }).click();
  const original = await readFile("samples/imagen-prueba.svg", "utf8");
  await page.getByLabel("Seleccionar archivo multimedia", { exact: true }).setInputFiles({ name: "otra-imagen.svg", mimeType: "image/svg+xml", buffer: Buffer.from(original.replace("#e7eee0", "#e7eee2")) });
  await page.getByRole("button", { name: "Preparar prueba" }).click();
  await expect(page.getByRole("alert")).toContainText("no tiene permiso");
});

/**
 * Transfiere la administración mediante dos wallets de laboratorio y las funciones reales del registro.
 * Entradas. Fixture page y dos cuentas experimentales.
 * Salida. Promesa sin valor. Comprueba la propuesta y la aceptación desde la cuenta correspondiente.
 */
test("la transferencia administrativa requiere propuesta y aceptación desde cuentas distintas", async ({ page }) => {
  await page.goto("/#administracion");
  await page.getByRole("button", { name: "Usar cuenta experimental" }).click();
  await expect(page.getByRole("button", { name: /0xf39/ })).toBeVisible();
  const recipient = await page.getByLabel("Cuenta experimental local", { exact: true }).locator("option").nth(1).getAttribute("value");
  await page.getByLabel("Nueva cuenta administradora", { exact: true }).fill(recipient!);
  await page.getByRole("button", { name: "Proponer administrador" }).click();
  await expect(page.getByText("Transferencia administrativa confirmada.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Aceptar administración" })).toBeDisabled();
  await page.getByLabel("Cuenta experimental local", { exact: true }).selectOption(recipient!);
  await page.getByRole("button", { name: "Aceptar administración" }).click();
  await expect(page.getByText("Transferencia administrativa confirmada.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Aceptar administración" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Acceder al conjunto privado" })).toBeEnabled();
});

/**
 * Comprueba navegación y ausencia de desbordamiento horizontal en un teléfono.
 * Entradas. Fixture page y dimensiones de pantalla configuradas en el caso.
 * Salida. Promesa sin valor. Comprueba la navegación y guarda una captura de la verificación móvil.
 */
test("la navegación y las consultas se adaptan a una pantalla móvil", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("link", { name: "Verificar contenido", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Verificar contenido", exact: true })).toBeVisible();
  expect(await page.evaluate(/* Mide el diseño real sin depender de capturas prefijadas. Entradas. Sin argumentos. Lee el ancho del documento y de la ventana del navegador. Salida. true si el contenido cabe horizontalmente. */ () => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/verificacion-movil.png", fullPage: true });
});
