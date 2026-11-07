/** Consulta archivos mediante la huella compartida y el contrato real, sin solicitar wallet ni una nueva ZKP. */
import { useEffect, useRef, useState } from "react";
import type { Configuration, ContentRecord } from "./types.ts";
import { hashFile, queryRegistry } from "./services.ts";
import { errorMessage } from "./errors.ts";
import { FilePicker, Icon, Notice, RecordView } from "./components.tsx";

/**
 * Procesa y consulta automáticamente el archivo seleccionado distinguiendo error operativo de ausencia de registro.
 * Entradas. Configuración pública del registro.
 * Salida. Vista React de consulta con selector, estado y resultado.
 */
export function Verify({ config }: { config: Configuration }) {
  const [file, setFile] = useState<File | null>(null);
  const [hash, setHash] = useState("");
  const [record, setRecord] = useState<ContentRecord>();
  const [error, setError] = useState("");
  const [state, setState] = useState("");
  const work = useRef<AbortController | null>(null);
  /**
   * Enlaza la cancelación de la consulta al ciclo de vida de la pantalla.
   * Entradas. Ningún argumento.
   * Salida. Función de limpieza para cancelar la consulta activa al desmontar.
   */
  useEffect(() => /* Cancela la verificación al desmontar la pantalla. Entradas. Sin argumentos. Consulta el controlador de la operación. Salida. Sin valor de retorno. Aborta el procesamiento si sigue activo. */ () => work.current?.abort(), []);
  /**
   * Recalcula los bytes exactos y consulta una sola huella sin interpretar semánticamente el contenido.
   * Entradas. Archivo local seleccionado.
   * Salida. Promesa sin valor. Actualiza la huella y el resultado de la consulta o muestra un error.
   */
  async function selectFile(selected: File) {
    work.current?.abort();
    if (selected.size > config.maxFileBytes || !/^(image|audio|video)\//.test(selected.type)) { setError("Selecciona una imagen, audio o video de hasta 25 MB."); return; }
    const controller = new AbortController(); work.current = controller;
    setFile(selected); setRecord(undefined); setError(""); setState("Calculando huella…");
    try {
      const value = await hashFile(selected, /* Muestra únicamente el porcentaje conocido de bytes procesados. Entradas. Bytes procesados y total del archivo. Salida. Sin valor de retorno. Actualiza el estado visual de cálculo. */ (processed, total) => setState("Calculando huella · " + Math.round(total ? processed / total * 100 : 100) + " %"), controller.signal);
      if (controller.signal.aborted) return;
      setHash(value); setState("Consultando el registro…");
      const result = await queryRegistry(config, value);
      if (!controller.signal.aborted) setRecord(result);
    } catch (failure) { if (!controller.signal.aborted) setError(errorMessage(failure)); }
    finally { if (!controller.signal.aborted) setState(""); }
  }
  return <><div className="page-title"><span className="eyebrow">CONSULTA PÚBLICA</span><h1>Verificar contenido</h1><p>Comprueba si los bytes de tu archivo tienen un registro aceptado.</p></div>
    <div className="workflow-layout"><section className="panel"><div className="panel-heading"><span className="section-number"><Icon name="search"/></span><div><h2>Consulta un archivo</h2><p>No necesitas conectar una wallet.</p></div></div><FilePicker file={file} onFile={selectFile} disabled={!config.deploymentReady}/>{state && <p className="processing" role="status"><span className="spinner"/>{state}</p>}{error && <Notice kind="error">{error}</Notice>}{!config.deploymentReady && <Notice>El registro todavía no está disponible. Prepara el sistema desde Administración.</Notice>}</section>
    <aside className="panel explanation"><Icon name="shield" size={32}/><h2>Una consulta,<br/>sin otra prueba.</h2><p>La ZKP se verificó al admitir el registro. Ahora basta recalcular la huella y consultar el contrato.</p><div className="divider"/><strong>¿Qué significa el resultado?</strong><p>Un registro relaciona unos bytes con una autorización aceptada. Su ausencia no demuestra que el contenido sea falso o haya sido manipulado.</p><span className="subtle-tag">SIN WALLET · SIN SUBIR EL ARCHIVO</span></aside></div>
    {record && <RecordView record={record} hash={hash} config={config}/>}</>;
}
