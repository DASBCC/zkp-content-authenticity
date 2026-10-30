/** Ofrece preparación, fuentes, raíces y permisos desde la web con autorización real de la cuenta administradora. */
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { Address } from "viem";
import type { Configuration } from "./types.ts";
import { administerRoot, transferAdministrator, api, authorizedRequest, getConfiguration } from "./services.ts";
import { errorMessage, short } from "./errors.ts";
import { Icon, Notice, Value } from "./components.tsx";
import { Deployment } from "./Deployment.tsx";

interface Source { sourceId: string; publicKey: string[]; available: boolean }
interface Plan { planId: string; root: string; count: number }
interface Validation { status: string; stage: string; checks: { name: string; passed: boolean; summary: string }[]; error?: string }

/** Administra solo los datos necesarios para operar; las claves privadas siempre permanecen en el servicio. */
export function Admin({ config, account, refresh }: { config: Configuration; account?: Address; refresh: () => Promise<void> }) {
  const [accepted, setAccepted] = useState(false);
  const [sources, setSources] = useState<Source[]>();
  const [sourceId, setSourceId] = useState("");
  const [proposedOwner, setProposedOwner] = useState("");
  const [plan, setPlan] = useState<Plan>();
  const [allowed, setAllowed] = useState("");
  const [enabled, setEnabled] = useState(config.signingEnabled);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [validation, setValidation] = useState<Validation>();
  const alive = useRef(true);
  /** Evita actualizar esta pantalla si el ensayo sigue ejecutándose después de navegar. */
  useEffect(() => () => { alive.current = false; }, []);
  const administrator = config.deploymentReady ? config.owner : config.bootstrapOwner;
  const owner = Boolean(account && administrator && account.toLowerCase() === administrator.toLowerCase());

  /** Ejecuta una acción administrativa mostrando su etapa y un resultado controlado. */
  async function action(label: string, operation: () => Promise<void>) {
    setBusy(label); setError(""); setMessage("");
    try { await operation(); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(""); }
  }

  /** Prepara claves de desarrollo y despliega ambos contratos tras la aceptación explícita del modo local. */
  async function bootstrap() { await action("Preparando fuente y contratos reales…", async () => { await authorizedRequest(config, "bootstrap", "/api/bootstrap", { experimental: true }); await refresh(); setMessage("Sistema preparado. Ya puedes registrar y verificar archivos desde el sitio."); }); }

  /** Consulta el conjunto y su política solamente después de autenticar al administrador. */
  async function loadSources() { await action("Autenticando acceso a las fuentes…", async () => { const value = await authorizedRequest<{ sources: Source[]; allowedRegistrants: string[]; signingEnabled: boolean }>(config, "admin-sources", "/api/admin/sources", {}); setSources(value.sources); setAllowed(value.allowedRegistrants.join("\n")); setEnabled(value.signingEnabled); }); }

  /** Prepara una alta, rotación o revocación sin cambiar todavía la raíz admitida por el contrato. */
  async function change(kind: string, id: string) { await action("Preparando el nuevo conjunto…", async () => { setPlan(await authorizedRequest<Plan>(config, "admin-change", "/api/admin/change", { kind, sourceId: id })); }); }

  /** Solicita crear la fuente cuyo identificador introdujo el administrador. */
  async function createSource() { await change("create", sourceId); }

  /** Publica la raíz con la wallet y sincroniza el conjunto privado solo después de comprobarla en cadena. */
  async function publish() {
    if (!plan) return;
    await action("Publicando y confirmando la nueva raíz…", async () => {
      const current = await getConfiguration();
      if (!current.rootEnabled || current.root !== plan.root) await administerRoot(config, plan.root);
      await authorizedRequest(config, "admin-commit", "/api/admin/commit", { planId: plan.planId });
      setPlan(undefined); setSources(undefined); await refresh(); setMessage("Raíz confirmada y conjunto sincronizado. Los registros históricos se conservan.");
    });
  }

  /** Importa un conjunto JSON preparado por el administrador sin publicarlo al resto de usuarios. */
  async function importSources(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    await action("Validando el conjunto importado…", async () => { if (file.size > 128 * 1024) throw new Error("Conjunto demasiado grande"); const value = JSON.parse(await file.text()); setPlan(await authorizedRequest<Plan>(config, "admin-prepare", "/api/admin/prepare", { sources: value })); });
    event.target.value = "";
  }

  /** Deshabilita nuevos registros mediante una transacción del administrador. */
  async function disable() { await action("Deshabilitando la raíz…", async () => { await administerRoot(config); await refresh(); setMessage("Se deshabilitaron nuevos registros. Las consultas históricas siguen disponibles."); }); }

  /** Reactiva la raíz existente mediante una confirmación de la wallet administradora. */
  async function enableRoot() { await action("Habilitando la raíz actual…", async () => { await administerRoot(config, config.root); await refresh(); setMessage("Raíz habilitada."); }); }
  /** Ejecuta una propuesta o aceptación de transferencia según la cuenta conectada. */
  async function ownership(accept = false) { await action("Confirmando transferencia administrativa…", async () => { await transferAdministrator(config, accept ? undefined : proposedOwner as Address); await refresh(); setMessage("Transferencia administrativa confirmada."); }); }
  /** Guarda las cuentas que pueden pedir firmas y el estado del servicio de emisión. */
  async function savePolicy() { await action("Guardando permisos de emisión…", async () => { await authorizedRequest(config, "admin-policy", "/api/admin/policy", { allowedRegistrants: allowed.split(/[\s,]+/).filter(Boolean), signingEnabled: enabled }); await refresh(); setMessage("Permisos de emisión actualizados."); }); }

  /** Cierra los procesos locales iniciados por el lanzador después de una autorización administrativa. */
  async function shutdown() { await action("Cerrando el sistema local…", async () => { await authorizedRequest(config, "shutdown", "/api/shutdown", {}); setMessage("Sistema detenido. Puedes cerrar esta pestaña y volver a abrirlo desde el lanzador."); }); }

  /** Ejecuta el build, las pruebas de contratos y el E2E desde el botón de validación del sitio. */
  async function validate() {
    setError(""); setValidation({ status: "running", stage: "Solicitando validación…", checks: [] });
    try {
      const job = await authorizedRequest<{ jobId: string; jobToken: string }>(config, "diagnostics", "/api/admin/validate", {});
      while (alive.current) {
        const value = await api<Validation>("/api/admin/validate/" + job.jobId, { headers: { Authorization: "Bearer " + job.jobToken } });
        if (!alive.current) return;
        setValidation(value);
        if (value.status !== "running") break;
        await new Promise(/* Consulta etapas reales sin simular un porcentaje de aprobación. */ (resolve) => setTimeout(resolve, 1000));
      }
    } catch (failure) { setError(errorMessage(failure)); setValidation(undefined); }
  }

  /** Descarga el reporte público de validación sin logs de solicitudes o datos privados. */
  function downloadValidation() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ runAt: new Date().toISOString(), artifactId: config.artifactId, validation }, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "traza-validacion.json"; anchor.click(); URL.revokeObjectURL(url);
  }

  return <><div className="page-title"><span className="eyebrow">CONTROL DEL PROTOCOLO</span><h1>Administración</h1><p>Prepara el sistema y gestiona quién puede autorizar nuevos registros.</p></div>
    {!owner && (config.deploymentReady || config.network === "localhost") && <Notice>Conecta la cuenta administradora{config.localWalletAvailable ? " o activa la cuenta experimental local" : ""} para habilitar estas operaciones.{administrator && <><br/><code>{administrator}</code></>}</Notice>}
    {error && <Notice kind="error">{error}</Notice>}{message && <Notice kind="success">{message}</Notice>}{busy && <p className="processing" role="status"><span className="spinner"/>{busy}</p>}
    {!config.deploymentReady ? config.network === "localhost" ? <section className="panel setup-panel"><div className="upload-icon"><Icon name="settings" size={32}/></div><h2>Tu sistema, listo desde aquí.</h2><p>Prepara una fuente de desarrollo, el verificador Groth16, el registro y su raíz autorizada. El archivo multimedia se procesará en tu dispositivo.</p><label className="checkbox"><input type="checkbox" checked={accepted} onChange={/* Registra la aceptación expresa antes de crear material de desarrollo. */ (event) => setAccepted(event.target.checked)}/>Habilitar el entorno experimental local con claves de desarrollo.</label><button className="button primary" onClick={bootstrap} disabled={!owner || !accepted || Boolean(busy)}>Preparar sistema local <Icon name="arrow"/></button></section> : <Deployment config={config} account={account} refresh={refresh}/>
    : <><div className="admin-grid"><section className="panel"><div className="panel-heading"><Icon name="link"/><div><h2>Conjunto autorizado</h2><p>Una sola raíz activa para registros nuevos.</p></div><span className={"status-pill " + (config.rootEnabled ? "" : "muted")}>{config.rootEnabled ? "Habilitado" : "Deshabilitado"}</span></div><Value label="Raíz Merkle actual" value={config.root}/><Value label="Propietario del registro" value={config.owner}/><button className="button secondary danger" onClick={disable} disabled={!owner || Boolean(busy) || !config.rootEnabled}>Deshabilitar nuevos registros</button>{!config.rootEnabled && <button className="button secondary" onClick={enableRoot} disabled={!owner || Boolean(busy)}>Habilitar raíz actual</button>}<p className="helper">La revocación y la desactivación conservan el historial ya confirmado.</p></section>
    <section className="panel"><div className="panel-heading"><Icon name="shield"/><div><h2>Fuentes autorizadas</h2><p>Claves privadas conservadas en el servidor.</p></div></div>{!sources ? <button className="button secondary" onClick={loadSources} disabled={!owner || Boolean(busy)}>Acceder al conjunto privado</button> : <><div className="sources-list">{sources.length === 0 && <p>El conjunto está vacío.</p>}{sources.map(/* Presenta identidades únicamente dentro del área autenticada de administración. */ (source) => <div className="source-row" key={source.sourceId}><div><strong>Fuente {source.sourceId}</strong><span>{source.available ? "Clave disponible en el servicio" : "Fuente externa"} · {short(source.publicKey[0], 5)}</span></div><button className="text-button" disabled={Boolean(busy)} onClick={/* Prepara una nueva clave de esta fuente sin exponerla. */ () => change("rotate", source.sourceId)}>Rotar</button><button className="text-button danger" disabled={Boolean(busy)} onClick={/* Propone retirar la fuente del conjunto activo. */ () => change("revoke", source.sourceId)}>Revocar</button></div>)}</div><div className="input-row"><label>Identificador de nueva fuente<input value={sourceId} onChange={/* Conserva el identificador decimal que validará el servicio. */ (event) => setSourceId(event.target.value)} inputMode="numeric" placeholder="Ej. 2"/></label><button className="button secondary" onClick={createSource} disabled={Boolean(busy) || !sourceId}>Crear fuente</button></div></>}<label className="import-label">Importar un conjunto JSON<input type="file" accept="application/json,.json" disabled={!owner || Boolean(busy)} onChange={importSources}/></label></section></div>
    {plan && <section className="panel proposed"><span className="eyebrow">CAMBIO PREPARADO · AÚN NO PUBLICADO</span><h2>Revisa la nueva raíz</h2><p>{plan.count} fuentes en el nuevo conjunto. Al confirmar, la raíz anterior deja de admitir nuevos registros.</p><Value label="Raíz propuesta" value={plan.root}/><button className="button primary" disabled={Boolean(busy)} onClick={publish}>Publicar y sincronizar conjunto <Icon name="arrow"/></button></section>}
    {sources && <section className="panel"><div className="panel-heading"><Icon name="wallet"/><div><h2>Permisos de emisión</h2><p>La wallet firma un permiso y el servicio verifica esta lista antes de autorizar contenido.</p></div></div><label className="field">Cuentas admitidas, una por línea<textarea rows={4} value={allowed} onChange={/* Edita la política local sin actualizarla hasta confirmar la operación. */ (event) => setAllowed(event.target.value)} spellCheck={false}/></label><label className="checkbox"><input type="checkbox" checked={enabled} onChange={/* Prepara el estado de emisión que confirmará el administrador. */ (event) => setEnabled(event.target.checked)}/>Permitir solicitudes de autorización de las cuentas admitidas.</label><button className="button secondary" onClick={savePolicy} disabled={Boolean(busy)}>Guardar permisos</button></section>}
    {owner && <details className="panel"><summary>Nuevo despliegue firmado por mi wallet</summary><Deployment config={config} account={account} refresh={refresh}/></details>}<section className="panel"><div className="panel-heading"><Icon name="wallet"/><div><h2>Administración en dos pasos</h2><p>La nueva cuenta debe aceptar la transferencia desde su propia wallet.</p></div></div><div className="input-row"><label>Nueva cuenta administradora<input value={proposedOwner} onChange={/* Conserva la dirección que validarán viem y el contrato al proponerla. */ (event) => setProposedOwner(event.target.value)} placeholder="0x…" spellCheck={false}/></label><button className="button secondary" onClick={/* Solicita únicamente la propuesta de transferencia, sin aceptarla por otra cuenta. */ () => ownership()} disabled={!owner || Boolean(busy) || !/^0x[0-9a-fA-F]{40}$/.test(proposedOwner)}>Proponer administrador</button></div>{config.pendingOwner && BigInt(config.pendingOwner) !== 0n && <><Value label="Cuenta pendiente de aceptación" value={config.pendingOwner}/><button className="button secondary" disabled={Boolean(busy) || account?.toLowerCase() !== config.pendingOwner.toLowerCase()} onClick={/* Acepta desde la cuenta conectada que el contrato comprueba como destinataria. */ () => ownership(true)}>Aceptar administración</button></>}</section>{config.localWalletAvailable && <section className="panel"><div className="panel-heading"><Icon name="check"/><div><h2>Validación del sistema</h2><p>Compilación, contratos, módulos y recorrido completo en navegador.</p></div></div><button className="button secondary" onClick={validate} disabled={!owner || Boolean(busy) || validation?.status === "running"}>Ejecutar validación completa</button>{validation && <div aria-live="polite"><p className="processing">{validation.status === "running" && <span className="spinner"/>}{validation.stage}</p>{validation.checks.map(/* Presenta resultados reales de cada herramienta ejecutada. */ (check) => <Notice key={check.name} kind={check.passed ? "success" : "error"}>{check.name}: {check.summary}</Notice>)}{validation.error && <Notice kind="error">{validation.error}</Notice>}{validation.status !== "running" && <button className="text-button" onClick={downloadValidation}>Descargar reporte de validación</button>}</div>}</section>}<section className="panel"><div className="panel-heading"><Icon name="info"/><div><h2>Despliegue y artefactos</h2><p>Valores efectivos del sistema conectado.</p></div></div><div className="record-grid"><div><span>Red / cadena</span><strong>{config.network} / {config.chainId}</strong></div><div><span>Versión</span><strong>v{config.protocolVersion}</strong></div><div><span>Servicio de firma</span><strong>{config.signingEnabled ? "Habilitado" : "Deshabilitado"}</strong></div></div><Value label="Registry" value={config.registryAddress}/><Value label="Verifier" value={config.verifierAddress}/><Value label="Identificador de artefactos" value={config.artifactId}/><Value label="Dominio del protocolo" value={config.protocolDomain}/><details className="technical"><summary>Circuito, herramientas y nivel de confianza</summary><p>{config.circuitMetrics?.constraints} restricciones · {config.circuitMetrics?.publicInputs} señales públicas · {config.circuitMetrics?.outputs} salidas</p><p>Compilación: {Number(config.circuitMetrics?.compilationMs).toFixed(1)} ms · Setup: {Number(config.circuitMetrics?.setupMs).toFixed(1)} ms</p>{Object.entries(config.tools ?? {}).map(/* Publica únicamente versiones de herramientas, nunca material de fuente. */ ([name, version]) => <p key={name}>{name}: {version}</p>)}<p>{config.setup?.origin}. {config.setup?.trust}.</p></details>{config.localWalletAvailable && <button className="button secondary danger" disabled={!owner || Boolean(busy)} onClick={shutdown}>Detener sistema local</button>}</section></>}
  </>;
}
