/** Ofrece preparación, fuentes, raíces y permisos desde la web con autorización real de la cuenta administradora. */
import { useState } from "react";
import type { Address } from "viem";
import type { Configuration } from "./types.ts";
import { administerRoot, transferAdministrator, authorizedRequest, getConfiguration } from "./services.ts";
import { errorMessage, short } from "./errors.ts";
import { Icon, Notice, Value } from "./components.tsx";
import { Deployment } from "./Deployment.tsx";

interface Source { sourceId: string; publicKey: string[]; available: boolean }
interface Plan { planId: string; root: string; count: number }

/**
 * Presenta las operaciones administrativas de fuentes, raíz y permisos.
 * Entradas. Configuración pública, cuenta conectada opcional y función de recarga.
 * Salida. Vista React de administración con acciones acordes a la cuenta y al despliegue.
 */
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
  const administrator = config.deploymentReady ? config.owner : config.bootstrapOwner;
  const owner = Boolean(account && administrator && account.toLowerCase() === administrator.toLowerCase());

  /**
   * Ejecuta una acción administrativa mostrando su etapa y un resultado controlado.
   * Entradas. Etiqueta de progreso y función asíncrona de la operación.
   * Salida. Promesa sin valor. Actualiza el estado y muestra los errores de la operación.
   */
  async function action(label: string, operation: () => Promise<void>) {
    setBusy(label); setError(""); setMessage("");
    try { await operation(); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(""); }
  }

  /**
   * Prepara claves de desarrollo y despliega ambos contratos tras la aceptación explícita del modo local.
   * Entradas. Sin argumentos. Usa la configuración actual y la wallet.
   * Salida. Promesa sin valor. Solicita la preparación experimental y recarga la configuración.
   */
  async function bootstrap() { await action("Preparando fuente y contratos reales…", /* Coordina la solicitud de preparación experimental. Entradas. Sin argumentos. Usa la configuración y la función de recarga. Salida. Promesa sin valor. Autoriza la preparación y actualiza el estado de la vista. */ async () => { await authorizedRequest(config, "bootstrap", "/api/bootstrap", { experimental: true }); await refresh(); setMessage("Sistema preparado. Ya puedes registrar y verificar archivos desde el sitio."); }); }

  /**
   * Consulta el conjunto y su política solamente después de autenticar al administrador.
   * Entradas. Sin argumentos. Usa la sesión y la configuración del componente.
   * Salida. Promesa sin valor. Carga las fuentes y la política en el formulario.
   */
  async function loadSources() { await action("Autenticando acceso a las fuentes…", /* Aplica la respuesta autenticada al formulario. Entradas. Sin argumentos. Usa la configuración y la wallet. Salida. Promesa sin valor. Rellena fuentes, cuentas admitidas y estado de emisión. */ async () => { const value = await authorizedRequest<{ sources: Source[]; allowedRegistrants: string[]; signingEnabled: boolean }>(config, "admin-sources", "/api/admin/sources", {}); setSources(value.sources); setAllowed(value.allowedRegistrants.join("\n")); setEnabled(value.signingEnabled); }); }

  /**
   * Prepara una alta, rotación o revocación sin cambiar todavía la raíz admitida por el contrato.
   * Entradas. Tipo de cambio e identificador de fuente.
   * Salida. Promesa sin valor. Guarda en el componente el plan recibido.
   */
  async function change(kind: string, id: string) { await action("Preparando el nuevo conjunto…", /* Solicita el plan de cambio de fuentes. Entradas. Sin argumentos. Usa el tipo de cambio y el identificador del cierre. Salida. Promesa sin valor. Almacena el plan recibido. */ async () => { setPlan(await authorizedRequest<Plan>(config, "admin-change", "/api/admin/change", { kind, sourceId: id })); }); }

  /**
   * Solicita crear la fuente cuyo identificador introdujo el administrador.
   * Entradas. Sin argumentos. Usa el identificador escrito en el formulario.
   * Salida. Promesa sin valor. Prepara el plan de alta.
   */
  async function createSource() { await change("create", sourceId); }

  /**
   * Publica la raíz con la wallet y sincroniza el conjunto privado solo después de comprobarla en cadena.
   * Entradas. Sin argumentos. Usa el plan preparado, si existe.
   * Salida. Promesa sin valor. Publica la raíz, confirma el conjunto y actualiza la vista.
   */
  async function publish() {
    if (!plan) return;
    await action("Publicando y confirmando la nueva raíz…", /* Ejecuta la publicación autorizada de la raíz y del conjunto asociado. Entradas. Sin argumentos. Usa el plan de publicación del cierre. Salida. Promesa sin valor. Sincroniza la raíz y el conjunto después de la confirmación. */ async () => {
      const current = await getConfiguration();
      if (!current.rootEnabled || current.root !== plan.root) await administerRoot(config, plan.root);
      await authorizedRequest(config, "admin-commit", "/api/admin/commit", { planId: plan.planId });
      setPlan(undefined); setSources(undefined); await refresh(); setMessage("Raíz confirmada y conjunto sincronizado. Los registros históricos se conservan.");
    });
  }

  /**
   * Deshabilita nuevos registros mediante una transacción del administrador.
   * Entradas. Sin argumentos. Usa la configuración y la wallet administradora.
   * Salida. Promesa sin valor. Deshabilita la raíz y actualiza la vista.
   */
  async function disable() { await action("Deshabilitando la raíz…", /* Confirma la desactivación de nuevos registros. Entradas. Sin argumentos. Usa la configuración y la recarga. Salida. Promesa sin valor. Actualiza la raíz en cadena y la vista. */ async () => { await administerRoot(config); await refresh(); setMessage("Se deshabilitaron nuevos registros. Las consultas históricas siguen disponibles."); }); }

  /**
   * Reactiva la raíz existente mediante una confirmación de la wallet administradora.
   * Entradas. Sin argumentos. Usa la raíz de la configuración actual.
   * Salida. Promesa sin valor. Reactiva la raíz y actualiza la vista.
   */
  async function enableRoot() { await action("Habilitando la raíz actual…", /* Confirma la reactivación de la raíz. Entradas. Sin argumentos. Usa la raíz actual de la configuración. Salida. Promesa sin valor. Habilita la raíz y actualiza la vista. */ async () => { await administerRoot(config, config.root); await refresh(); setMessage("Raíz habilitada."); }); }
  /**
   * Ejecuta una propuesta o aceptación de transferencia según la cuenta conectada.
   * Entradas. Indicador de aceptación. Para una propuesta usa la dirección del formulario.
   * Salida. Promesa sin valor. Ejecuta la transacción y actualiza la configuración.
   */
  async function ownership(accept = false) { await action("Confirmando transferencia administrativa…", /* Envía la propuesta o aceptación administrativa. Entradas. Sin argumentos. Usa el indicador de aceptación y la dirección propuesta. Salida. Promesa sin valor. Ejecuta la transferencia correspondiente y recarga la configuración. */ async () => { await transferAdministrator(config, accept ? undefined : proposedOwner as Address); await refresh(); setMessage("Transferencia administrativa confirmada."); }); }
  /**
   * Guarda las cuentas que pueden pedir firmas y el estado del servicio de emisión.
   * Entradas. Sin argumentos. Usa las cuentas y el estado de firma del formulario.
   * Salida. Promesa sin valor. Guarda la política de emisión y muestra el resultado.
   */
  async function savePolicy() { await action("Guardando permisos de emisión…", /* Envía la política de emisión del formulario. Entradas. Sin argumentos. Usa las cuentas permitidas y el estado de firma editados. Salida. Promesa sin valor. Guarda la política y actualiza la vista. */ async () => { await authorizedRequest(config, "admin-policy", "/api/admin/policy", { allowedRegistrants: allowed.split(/[\s,]+/).filter(Boolean), signingEnabled: enabled }); await refresh(); setMessage("Permisos de emisión actualizados."); }); }

  /**
   * Cierra los procesos locales iniciados por el lanzador después de una autorización administrativa.
   * Entradas. Sin argumentos. Usa la configuración y la wallet administradora.
   * Salida. Promesa sin valor. Pide el cierre al servicio y muestra la confirmación.
   */
  async function shutdown() { await action("Cerrando el sistema local…", /* Envía la orden autenticada de cierre. Entradas. Sin argumentos. Usa la configuración y la wallet administradora. Salida. Promesa sin valor. Solicita el cierre y muestra su confirmación. */ async () => { await authorizedRequest(config, "shutdown", "/api/shutdown", {}); setMessage("Sistema detenido. Puedes cerrar esta pestaña y volver a abrirlo desde el lanzador."); }); }

  return <><div className="page-title"><span className="eyebrow">CONTROL DEL PROTOCOLO</span><h1>Administración</h1><p>Prepara el sistema y gestiona quién puede autorizar nuevos registros.</p></div>
    {!owner && (config.deploymentReady || config.network === "localhost") && <Notice>Conecta la cuenta administradora{config.localWalletAvailable ? " o activa la cuenta experimental local" : ""} para habilitar estas operaciones.{administrator && <><br/><code>{administrator}</code></>}</Notice>}
    {error && <Notice kind="error">{error}</Notice>}{message && <Notice kind="success">{message}</Notice>}{busy && <p className="processing" role="status"><span className="spinner"/>{busy}</p>}
    {!config.deploymentReady ? config.network === "localhost" ? <section className="panel setup-panel"><div className="upload-icon"><Icon name="settings" size={32}/></div><h2>Tu sistema, listo desde aquí.</h2><p>Prepara una fuente de desarrollo, el verificador Groth16, el registro y su raíz autorizada. El archivo multimedia se procesará en tu dispositivo.</p><label className="checkbox"><input type="checkbox" checked={accepted} onChange={/* Registra la aceptación expresa antes de crear material de desarrollo. Entradas. Evento del selector de aceptación. Salida. Sin valor de retorno. Guarda la selección de modo local. */ (event) => setAccepted(event.target.checked)}/>Habilitar el entorno experimental local con claves de desarrollo.</label><button className="button primary" onClick={bootstrap} disabled={!owner || !accepted || Boolean(busy)}>Preparar sistema local <Icon name="arrow"/></button></section> : <Deployment config={config} account={account} refresh={refresh}/>
    : <><div className="admin-grid"><section className="panel"><div className="panel-heading"><Icon name="link"/><div><h2>Conjunto autorizado</h2><p>Una sola raíz activa para registros nuevos.</p></div><span className={"status-pill " + (config.rootEnabled ? "" : "muted")}>{config.rootEnabled ? "Habilitado" : "Deshabilitado"}</span></div><Value label="Raíz Merkle actual" value={config.root}/><Value label="Propietario del registro" value={config.owner}/><button className="button secondary danger" onClick={disable} disabled={!owner || Boolean(busy) || !config.rootEnabled}>Deshabilitar nuevos registros</button>{!config.rootEnabled && <button className="button secondary" onClick={enableRoot} disabled={!owner || Boolean(busy)}>Habilitar raíz actual</button>}<p className="helper">La revocación y la desactivación conservan el historial ya confirmado.</p></section>
    <section className="panel"><div className="panel-heading"><Icon name="shield"/><div><h2>Fuentes autorizadas</h2><p>Claves privadas conservadas en el servidor.</p></div></div>{!sources ? <button className="button secondary" onClick={loadSources} disabled={!owner || Boolean(busy)}>Acceder al conjunto privado</button> : <><div className="sources-list">{sources.length === 0 && <p>El conjunto está vacío.</p>}{sources.map(/* Presenta identidades únicamente dentro del área autenticada de administración. Entradas. Fuente autorizada con clave y disponibilidad. Salida. Fila React de la lista con acciones de administración. */ (source) => <div className="source-row" key={source.sourceId}><div><strong>Fuente {source.sourceId}</strong><span>{source.available ? "Clave disponible en el servicio" : "Fuente externa"} · {short(source.publicKey[0], 5)}</span></div><button className="text-button" disabled={Boolean(busy)} onClick={/* Prepara una nueva clave de esta fuente sin exponerla. Entradas. Sin argumentos. Usa el identificador de la fila. Salida. Promesa sin valor de la preparación del plan de rotación. */ () => change("rotate", source.sourceId)}>Rotar</button><button className="text-button danger" disabled={Boolean(busy)} onClick={/* Propone retirar la fuente del conjunto activo. Entradas. Sin argumentos. Usa el identificador de la fila. Salida. Promesa sin valor de la preparación del plan de revocación. */ () => change("revoke", source.sourceId)}>Revocar</button></div>)}</div><div className="input-row"><label>Identificador de nueva fuente<input value={sourceId} onChange={/* Conserva el identificador decimal que validará el servicio. Entradas. Evento de edición del identificador de fuente. Salida. Sin valor de retorno. Actualiza el identificador del formulario. */ (event) => setSourceId(event.target.value)} inputMode="numeric" placeholder="Ej. 2"/></label><button className="button secondary" onClick={createSource} disabled={Boolean(busy) || !sourceId}>Crear fuente</button></div></>}</section></div>
    {plan && <section className="panel proposed"><span className="eyebrow">CAMBIO PREPARADO · AÚN NO PUBLICADO</span><h2>Revisa la nueva raíz</h2><p>{plan.count} fuentes en el nuevo conjunto. Al confirmar, la raíz anterior deja de admitir nuevos registros.</p><Value label="Raíz propuesta" value={plan.root}/><button className="button primary" disabled={Boolean(busy)} onClick={publish}>Publicar y sincronizar conjunto <Icon name="arrow"/></button></section>}
    {sources && <section className="panel"><div className="panel-heading"><Icon name="wallet"/><div><h2>Permisos de emisión</h2><p>La wallet firma un permiso y el servicio verifica esta lista antes de autorizar contenido.</p></div></div><label className="field">Cuentas admitidas, una por línea<textarea rows={4} value={allowed} onChange={/* Edita la política local sin actualizarla hasta confirmar la operación. Entradas. Evento de edición de las cuentas admitidas. Salida. Sin valor de retorno. Actualiza el texto de la política. */ (event) => setAllowed(event.target.value)} spellCheck={false}/></label><label className="checkbox"><input type="checkbox" checked={enabled} onChange={/* Prepara el estado de emisión que confirmará el administrador. Entradas. Evento del selector de emisión. Salida. Sin valor de retorno. Actualiza el indicador de firma. */ (event) => setEnabled(event.target.checked)}/>Permitir solicitudes de autorización de las cuentas admitidas.</label><button className="button secondary" onClick={savePolicy} disabled={Boolean(busy)}>Guardar permisos</button></section>}
    {owner && <details className="panel"><summary>Nuevo despliegue firmado por mi wallet</summary><Deployment config={config} account={account} refresh={refresh}/></details>}<section className="panel"><div className="panel-heading"><Icon name="wallet"/><div><h2>Administración en dos pasos</h2><p>La nueva cuenta debe aceptar la transferencia desde su propia wallet.</p></div></div><div className="input-row"><label>Nueva cuenta administradora<input value={proposedOwner} onChange={/* Conserva la dirección que validarán viem y el contrato al proponerla. Entradas. Evento de edición de la cuenta propuesta. Salida. Sin valor de retorno. Actualiza la dirección del formulario. */ (event) => setProposedOwner(event.target.value)} placeholder="0x…" spellCheck={false}/></label><button className="button secondary" onClick={/* Solicita únicamente la propuesta de transferencia, sin aceptarla por otra cuenta. Entradas. Ningún argumento utilizado. Salida. Promesa sin valor de la propuesta de transferencia. */ () => ownership()} disabled={!owner || Boolean(busy) || !/^0x[0-9a-fA-F]{40}$/.test(proposedOwner)}>Proponer administrador</button></div>{config.pendingOwner && BigInt(config.pendingOwner) !== 0n && <><Value label="Cuenta pendiente de aceptación" value={config.pendingOwner}/><button className="button secondary" disabled={Boolean(busy) || account?.toLowerCase() !== config.pendingOwner.toLowerCase()} onClick={/* Acepta desde la cuenta conectada que el contrato comprueba como destinataria. Entradas. Ningún argumento utilizado. Salida. Promesa sin valor de la aceptación de transferencia. */ () => ownership(true)}>Aceptar administración</button></>}</section><section className="panel"><div className="panel-heading"><Icon name="info"/><div><h2>Despliegue y artefactos</h2><p>Valores efectivos del sistema conectado.</p></div></div><div className="record-grid"><div><span>Red / cadena</span><strong>{config.network} / {config.chainId}</strong></div><div><span>Versión</span><strong>v{config.protocolVersion}</strong></div><div><span>Servicio de firma</span><strong>{config.signingEnabled ? "Habilitado" : "Deshabilitado"}</strong></div></div><Value label="Registry" value={config.registryAddress}/><Value label="Verifier" value={config.verifierAddress}/><Value label="Identificador de artefactos" value={config.artifactId}/><Value label="Dominio del protocolo" value={config.protocolDomain}/><details className="technical"><summary>Circuito, herramientas y nivel de confianza</summary><p>{config.circuitMetrics?.constraints} restricciones · {config.circuitMetrics?.publicInputs} señales públicas · {config.circuitMetrics?.outputs} salidas</p><p>Compilación: {Number(config.circuitMetrics?.compilationMs).toFixed(1)} ms · Setup: {Number(config.circuitMetrics?.setupMs).toFixed(1)} ms</p>{Object.entries(config.tools ?? {}).map(/* Publica únicamente versiones de herramientas, nunca material de fuente. Entradas. Par con nombre y versión de una herramienta. Salida. Elemento React que muestra el par. */ ([name, version]) => <p key={name}>{name}: {version}</p>)}<p>{config.setup?.origin}. {config.setup?.trust}.</p></details>{config.localWalletAvailable && <button className="button secondary danger" disabled={!owner || Boolean(busy)} onClick={shutdown}>Detener sistema local</button>}</section></>}
  </>;
}
