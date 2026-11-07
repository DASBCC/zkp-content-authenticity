/** Reúne los controles accesibles de archivos, mensajes y resultados públicos compartidos por las pantallas. */
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, ReactNode } from "react";
import type { Configuration, ContentRecord } from "./types.ts";
import { short } from "./errors.ts";

/**
 * Dibuja iconos propios con trazos SVG sin dependencias gráficas externas.
 * Entradas. Nombre del icono y tamaño opcional, de 20 por defecto.
 * Salida. Elemento SVG para mostrar el icono.
 */
export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    home: <><path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/></>,
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5M8 10.5l2 2 3-4"/></>,
    settings: <><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="9" cy="18" r="2"/></>,
    book: <><path d="M12 5C8 2 4 3 2 4v16c3-1 7-1 10 1 3-2 7-2 10-1V4c-2-1-6-2-10 1Zm0 0v16"/></>,
    arrow: <path d="M4 12h15m-5-5 5 5-5 5"/>, check: <path d="m5 12 4 4L20 5"/>,
    shield: <><path d="m12 2 8 4v7c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/></>,
    file: <><path d="M5 2h9l5 5v15H5Zm9 0v6h5M8 13h8M8 17h6"/></>,
    wallet: <><path d="M3 5h16v15H3Z"/><path d="M3 5V3h13v2m0 5h6v6h-6Z"/><path d="M18 13h1"/></>,
    link: <><path d="m9 15 6-6m-5-2 3-3a4 4 0 0 1 6 6l-3 3m-2 4-3 3a4 4 0 0 1-6-6l3-3"/></>,
    info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/></>,
    close: <path d="m6 6 12 12M6 18 18 6"/>, plus: <path d="M12 4v16M4 12h16"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.info}</svg>;
}

/**
 * Muestra una notificación cuyo tono distingue éxito, información y falla operativa.
 * Entradas. Contenido y tipo opcional de aviso, informativo por defecto.
 * Salida. Elemento React con el estilo correspondiente al aviso.
 */
export function Notice({ children, kind = "info" }: { children: ReactNode; kind?: "info" | "success" | "error" }) {
  return <div className={"notice " + kind} role={kind === "error" ? "alert" : "status"}><Icon name={kind === "success" ? "check" : "info"}/><div>{children}</div></div>;
}

/**
 * Presenta un identificador completo con ajuste de línea y acceso directo a copiar su valor público.
 * Entradas. Etiqueta e identificador público como texto.
 * Salida. Elemento React con el valor y un botón para copiarlo.
 */
export function Value({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  /**
   * Copia el identificador sin alterar su codificación original.
   * Entradas. Sin argumentos. Usa el texto recibido por el componente.
   * Salida. Promesa sin valor. Escribe el texto en el portapapeles y marca la copia.
   */
  async function copy() { await navigator.clipboard.writeText(value); setCopied(true); }
  return <div className="value"><span>{label}</span><div><code>{value}</code><button className="copy" type="button" onClick={copy} aria-label={"Copiar " + label}>{copied ? "Copiado" : "Copiar"}</button></div></div>;
}

/**
 * Permite seleccionar o arrastrar multimedia y mantiene la previsualización exclusivamente en memoria local.
 * Entradas. Archivo actual o null, callback de selección e indicador opcional de bloqueo.
 * Salida. Elemento React con zona de selección y vista previa.
 */
export function FilePicker({ file, onFile, disabled = false }: { file: File | null; onFile: (file: File) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState("");
  const [dragging, setDragging] = useState(false);
  /**
   * Libera cada URL temporal cuando se sustituye el archivo o se desmonta el control.
   * Entradas. Sin argumentos. Usa el archivo seleccionado.
   * Salida. Función de limpieza cuando crea una URL o undefined si no hay archivo.
   */
  useEffect(() => { if (!file) { setPreview(""); return; } const url = URL.createObjectURL(file); setPreview(url); return /* Libera la vista previa anterior. Entradas. Sin argumentos. Usa la URL del archivo del cierre. Salida. Sin valor de retorno. Revoca la URL temporal. */ () => URL.revokeObjectURL(url); }, [file]);
  /**
   * Entrega el primer archivo del selector manteniendo sus bytes originales.
   * Entradas. Evento de cambio del selector nativo de archivos.
   * Salida. Sin valor de retorno. Entrega el primer archivo si está presente.
   */
  function selected(event: ChangeEvent<HTMLInputElement>) { if (event.target.files?.[0]) onFile(event.target.files[0]); }
  /**
   * Abre el selector nativo desde un botón operable con teclado.
   * Entradas. Sin argumentos. Usa la referencia al selector nativo.
   * Salida. Sin valor de retorno. Solicita abrir el selector.
   */
  function choose() { input.current?.click(); }
  /**
   * Acepta un archivo arrastrado sin subirlo al servidor.
   * Entradas. Evento de arrastre con los archivos soltados.
   * Salida. Sin valor de retorno. Entrega el primer archivo si el selector está habilitado.
   */
  function dropped(event: DragEvent) { event.preventDefault(); setDragging(false); if (!disabled && event.dataTransfer.files[0]) onFile(event.dataTransfer.files[0]); }
  /**
   * Marca la zona de destino mientras un archivo pasa sobre ella.
   * Entradas. Evento de arrastre sobre la zona.
   * Salida. Sin valor de retorno. Marca la zona si admite archivos.
   */
  function drag(event: DragEvent) { event.preventDefault(); if (!disabled) setDragging(true); }
  /**
   * Restablece el estilo al abandonar la zona de destino.
   * Entradas. Ningún argumento.
   * Salida. Sin valor de retorno. Limpia el estado visual de arrastre.
   */
  function leave() { setDragging(false); }
  return <div className={"file-picker " + (dragging ? "dragging" : "")} onDragOver={drag} onDragLeave={leave} onDrop={dropped}>
    <input ref={input} aria-label="Seleccionar archivo multimedia" type="file" accept="image/*,audio/*,video/*" onChange={selected} disabled={disabled}/>
    {file ? <div className="selected-file">
      <div className="preview">{file.type.startsWith("image/") ? <img src={preview} alt="Vista previa del archivo seleccionado"/> : file.type.startsWith("video/") ? <video src={preview} controls/> : file.type.startsWith("audio/") ? <audio src={preview} controls/> : <Icon name="file" size={38}/>}</div>
      <div className="file-description"><strong>{file.name}</strong><span>{file.type || "Formato binario"} · {(file.size / 1024).toLocaleString("es", { maximumFractionDigits: 1 })} KB</span><button className="text-button" type="button" onClick={choose} disabled={disabled}>Cambiar archivo</button></div>
    </div> : <><div className="upload-icon"><Icon name="upload" size={29}/></div><h3>Tu archivo, tal como es.</h3><p>Arrastra una imagen, audio o video<br/>o selecciónalo desde tu dispositivo.</p><button className="button secondary" type="button" onClick={choose} disabled={disabled}>Seleccionar archivo <Icon name="plus" size={16}/></button><small>Hasta 25 MB · Los bytes permanecen en tu dispositivo</small></>}
  </div>;
}

/**
 * Muestra el significado de una consulta positiva o negativa sin atribuir veracidad semántica al archivo.
 * Entradas. Registro consultado, huella y configuración de red.
 * Salida. Elemento React con el resultado de la consulta y los datos públicos disponibles.
 */
export function RecordView({ record, hash, config }: { record: ContentRecord; hash: string; config: Configuration }) {
  return <section className={"result-card " + (record.exists ? "found" : "not-found")} aria-live="polite">
    <div className="result-heading"><span className="result-icon"><Icon name={record.exists ? "shield" : "search"} size={26}/></span><div><span className="eyebrow">RESULTADO DE LA CONSULTA</span><h2>{record.exists ? "Registro encontrado" : "Sin registro"}</h2></div></div>
    <p>{record.exists ? "Se encontró un registro aceptado por el protocolo para los bytes exactos de este archivo." : "No se encontró un registro aceptado para los bytes exactos del archivo."}</p>
    <Value label="Huella Poseidon · contentHash" value={hash}/>
    {record.exists && <div className="record-grid"><div><span>Fecha del registro</span><strong>{new Date(Number(record.registeredAt) * 1000).toLocaleString("es")}</strong></div><div><span>Versión del protocolo</span><strong>v{record.protocolVersion.toString()}</strong></div><div><span>Cuenta registradora</span><code title={record.registrant}>{short(record.registrant)}</code></div></div>}
    <Value label={"Contrato consultado · " + config.network + " / " + config.chainId} value={config.registryAddress}/>
  </section>;
}
