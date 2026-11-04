/** Conduce el registro real desde los bytes locales hasta la autorización, la ZKP y la confirmación EVM. */
import { useEffect, useRef, useState } from "react";
import type { Address, Hash } from "viem";
import type { Configuration, ContentRecord, ProofResult, PublicReceipt, Stage } from "./types.ts";
import { generateRegistrationProof, hashFile, queryRegistry, registerContent } from "./services.ts";
import { errorMessage } from "./errors.ts";
import { FilePicker, Icon, Notice, RecordView, Value } from "./components.tsx";

// Las etapas intermedias son estados reales del trabajador; solo el hashing muestra un porcentaje medido.
const STEPS = [{ name: "Huella del archivo", stages: ["selected", "hashing"] }, { name: "Permiso y firma de fuente", stages: ["hashed", "permission", "queued", "authorizing", "authorized"] }, { name: "Testigo y prueba ZKP", stages: ["witness", "proving", "verifying"] }, { name: "Registro en blockchain", stages: ["ready", "wallet", "submitted", "confirmed"] }];
const LABELS: Record<Stage, string> = { selected: "Archivo seleccionado", hashing: "Calculando huella", hashed: "Huella calculada", permission: "Confirma el permiso en tu wallet", queued: "En espera del servicio prover", authorizing: "Solicitando autorización", authorized: "Autorización recibida", witness: "Construyendo testigo privado", proving: "Generando prueba Groth16", verifying: "Verificando la prueba", ready: "Prueba verificada y lista", wallet: "Esperando confirmación de wallet", submitted: "Transacción enviada", confirmed: "Contenido registrado" };

/** Presenta el registro en dos decisiones: preparar la prueba y confirmar su transacción. */
export function Register({ config, account }: { config: Configuration; account?: Address }) {
  const [file, setFile] = useState<File | null>(null);
  const [hash, setHash] = useState("");
  const [stage, setStage] = useState<Stage>("selected");
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [proof, setProof] = useState<ProofResult>();
  const [receipt, setReceipt] = useState<PublicReceipt>();
  const [txHash, setTxHash] = useState<Hash>();
  const [record, setRecord] = useState<ContentRecord>();
  const work = useRef<AbortController | null>(null);

  /** Invalida una autorización al cambiar de cuenta y conserva el hashing, que no depende de la wallet. */
  useEffect(() => { setProof(undefined); if (!["selected", "hashing", "hashed", "confirmed"].includes(stage)) { work.current?.abort(); setBusy(false); setStage(hash ? "hashed" : "selected"); } }, [account]);
  /** Cancela el trabajo privado solo cuando se abandona la pantalla. */
  useEffect(() => () => work.current?.abort(), []);

  /** Valida el tipo y tamaño y calcula la huella sin transferir el archivo al servicio. */
  async function selectFile(selected: File) {
    work.current?.abort();
    if (selected.size > config.maxFileBytes || !/^(image|audio|video)\//.test(selected.type)) { setError("Selecciona una imagen, audio o video de hasta 25 MB."); return; }
    const controller = new AbortController(); work.current = controller;
    setFile(selected); setHash(""); setProof(undefined); setReceipt(undefined); setTxHash(undefined); setRecord(undefined); setError(""); setProgress(0); setBusy(true); setStage("hashing");
    try { const result = await hashFile(selected, /* Actualiza solo los bytes efectivamente procesados. */ (processed, total) => setProgress(total ? processed / total * 100 : 100), controller.signal); if (!controller.signal.aborted) { setHash(result); setStage("hashed"); setProgress(100); } }
    catch (failure) { if (!controller.signal.aborted) setError(errorMessage(failure)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }

  /** Solicita una autorización autenticada y recibe solamente la prueba pública resultante. */
  async function prepare() {
    const controller = new AbortController(); work.current = controller;
    setBusy(true); setError("");
    try { setProof(await generateRegistrationProof(config, hash, setStage, controller.signal)); }
    catch (failure) { if (!controller.signal.aborted) { setError(errorMessage(failure)); setStage("hashed"); } }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }

  /** Solicita a la wallet el registro y consulta el resultado después del recibo confirmado. */
  async function register() {
    if (!proof) return;
    setBusy(true); setError("");
    try { const confirmed = await registerContent(config, proof, /* Refleja etapas reales y conserva la referencia pública de la transacción. */ (value, transactionHash) => { setStage(value); if (transactionHash) setTxHash(transactionHash); }); setReceipt(confirmed); setRecord(await queryRegistry(config, hash)); }
    catch (failure) { setError(errorMessage(failure)); if (!txHash) setStage("ready"); }
    finally { setBusy(false); }
  }

  /** Interrumpe el hashing o el prover; una transacción enviada debe consultarse hasta su confirmación. */
  function cancel() { work.current?.abort(); setBusy(false); setStage(hash ? "hashed" : "selected"); }

  /** Descarga únicamente la prueba, señales públicas y recibo para su revisión posterior. */
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ proof, receipt }, /* Conserva enteros públicos sin pérdida de precisión. */ (_key, value) => typeof value === "bigint" ? value.toString() : value, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "traza-comprobante.json"; anchor.click(); URL.revokeObjectURL(url);
  }

  const current = STEPS.findIndex(/* Ubica la etapa actual sin inventar porcentajes de cálculo. */ (step) => step.stages.includes(stage));
  return <><div className="page-title"><span className="eyebrow">EVIDENCIA DE ORIGEN</span><h1>Registrar contenido</h1><p>Una autorización de fuente. Una prueba privada. Un registro verificable.</p></div>
    {!config.deploymentReady && <Notice>Prepara los contratos y la fuente desde Administración para comenzar.</Notice>}
    <div className="workflow-layout"><section className="panel"><div className="panel-heading"><span className="section-number">01</span><div><h2>Selecciona tu archivo</h2><p>La huella se calcula sobre sus bytes exactos.</p></div><span className="subtle-tag">LOCAL</span></div>
      <FilePicker file={file} onFile={selectFile} disabled={busy}/>
      {stage === "hashing" && <div className="hash-progress" role="progressbar" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}><div style={{ width: progress + "%" }}/><span>{Math.round(progress)} % de bytes procesados</span></div>}
      {hash && <Value label="Huella Poseidon · contentHash" value={hash}/>}
      {error && <Notice kind="error">{error}</Notice>}
      {busy && <p className="processing" role="status"><span className="spinner"/>{LABELS[stage]}</p>}
      {!receipt && <div className="action-row">{proof ? <button className="button primary" onClick={register} disabled={busy || !account}>Confirmar registro <Icon name="arrow"/></button> : <button className="button primary" onClick={prepare} disabled={busy || !hash || !account || !config.deploymentReady || !config.rootEnabled || !config.signingEnabled}>Preparar prueba <Icon name="arrow"/></button>}{busy && !["wallet", "submitted"].includes(stage) && <button className="text-button" onClick={cancel}>Cancelar</button>}</div>}
      {!account && <p className="helper">Conecta tu wallet o activa la cuenta experimental local para solicitar autorización.</p>}
      {txHash && <Value label="Transacción enviada" value={txHash}/>}
      {proof && <details className="technical"><summary>Prueba pública y métricas</summary><div className="metrics-grid"><div><strong>{proof.metrics.witnessMs.toFixed(1)} ms</strong><span>Testigo</span></div><div><strong>{proof.metrics.proveMs.toFixed(1)} ms</strong><span>Prueba</span></div><div><strong>{proof.metrics.verifyMs.toFixed(1)} ms</strong><span>Verificación</span></div><div><strong>{proof.metrics.proofBytes} B</strong><span>Prueba JSON</span></div></div><Value label="Conjunto de artefactos" value={proof.artifactId}/><p className="helper">La identidad de la fuente, su firma y el testigo permanecen en el servicio de confianza.</p><button className="button secondary" onClick={download}>Descargar comprobante</button>{receipt && <p className="helper">Gas: {receipt.gasUsed.toString()} · Bloque: {receipt.blockNumber.toString()}</p>}</details>}
    </section><aside className="panel steps-panel"><span className="eyebrow">RECORRIDO DEL REGISTRO</span><ol className="steps">{STEPS.map(/* Representa estados del proceso real, sin simular avance criptográfico. */ (step, index) => <li key={step.name} className={index < current || stage === "confirmed" ? "done" : index === current ? "active" : ""}><span>{index < current || stage === "confirmed" ? <Icon name="check" size={15}/> : index + 1}</span><div><strong>{step.name}</strong><p>{["Procesamiento en tu dispositivo", "Permiso firmado por tu wallet", "Generación en el servicio de confianza", "Confirmación con tu cuenta EVM"][index]}</p></div></li>)}</ol><div className="privacy-note"><Icon name="shield"/><strong>Privacidad por diseño</strong><p>Puedes estar tranquilo, tu archivo no se sube.</p></div></aside></div>
    {record && <RecordView record={record} hash={hash} config={config}/>}</>;
}
