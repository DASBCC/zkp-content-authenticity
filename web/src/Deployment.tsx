/** Despliega ambos contratos con la wallet del navegador y permite continuar tras una confirmación rechazada. */
import { useState } from "react";
import { encodeDeployData, encodeFunctionData, getContract } from "viem";
import type { Abi, Address, Hash, Hex } from "viem";
import type { Configuration } from "./types.ts";
import { api, authorizedRequest, currentWallet, estimateOperationGas, publicClient, switchNetwork } from "./services.ts";
import { ApplicationError, errorMessage } from "./errors.ts";
import { Icon, Notice, Value } from "./components.tsx";

interface Plan {
  planId: string; planToken: string; owner: Address; chainId: string; root: string; artifactId: string;
  verifier: { abi: Abi; bytecode: Hex }; registry: { abi: Abi; bytecode: Hex };
  verifierTransaction?: Hash; registryTransaction?: Hash; rootTransaction?: Hash;
}

/** Conserva solo un plan público de despliegue; la fuente y sus claves permanecen en el servidor. */
function storageKey(network: string, account: Address) { return "traza-deployment-" + network + "-" + account.toLowerCase(); }

/** Presenta tres transacciones explícitas y guarda sus referencias inmediatamente después de enviarlas. */
export function Deployment({ config, account, refresh }: { config: Configuration; account?: Address; refresh: () => Promise<void> }) {
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [plan, setPlan] = useState<Plan | undefined>(/* Recupera solo el avance de la cuenta y red conectadas. */ () => { try { return account ? JSON.parse(window.sessionStorage.getItem(storageKey(config.network, account)) || "null") ?? undefined : undefined; } catch { return undefined; } });

  /** Persiste el avance público para evitar volver a desplegar un contrato ya confirmado tras un rechazo. */
  function save(value: Plan) { setPlan({ ...value }); window.sessionStorage.setItem(storageKey(config.network, value.owner), JSON.stringify(value)); }

  /** Comprueba una cuenta y cadena constantes en cada firma o transacción del despliegue. */
  async function wallet(address?: Address) { return currentWallet(config, address); }

  /** Ejecuta preparación, dos creaciones, publicación de raíz y adopción comprobada desde el servicio. */
  async function deploy() {
    if (!account || !accepted) return;
    setBusy(true); setError("");
    let draft: Plan | undefined;
    let operation = "preparación";
    try {
      try { await wallet(account); } catch (failure) { if (failure instanceof ApplicationError && failure.code === "WrongChain") await switchNetwork(config); else throw failure; }
      const saved = window.sessionStorage.getItem(storageKey(config.network, account));
      draft = saved ? JSON.parse(saved) as Plan : undefined;
      if (!draft) { setStage("Confirma el permiso para preparar los contratos y la fuente de desarrollo."); draft = await authorizedRequest<Plan>(config, "wallet-deploy", "/api/deployment/prepare", { developmentSource: true }); save(draft); }
      if (draft.chainId !== config.chainId || draft.owner.toLowerCase() !== account.toLowerCase()) throw new ApplicationError("WrongRegistrant");
      const client = publicClient(config);
      operation = "Verifier";
      if (!draft.verifierTransaction) {
        setStage("1 de 3 · Estimando el gas del Verifier…");
        const gas = await estimateOperationGas(config, account, encodeDeployData({ abi: draft.verifier.abi, bytecode: draft.verifier.bytecode }));
        setStage("1 de 3 · Confirma el despliegue del Verifier en tu wallet.");
        draft.verifierTransaction = await (await wallet(account)).client.deployContract({ abi: draft.verifier.abi, bytecode: draft.verifier.bytecode, gas });
        save(draft);
      }
      setStage("Esperando confirmación del Verifier…");
      const verifierReceipt = await client.waitForTransactionReceipt({ hash: draft.verifierTransaction, timeout: 180_000 });
      if (verifierReceipt.status !== "success" || !verifierReceipt.contractAddress) { delete draft.verifierTransaction; delete draft.registryTransaction; delete draft.rootTransaction; save(draft); throw new ApplicationError("DEPLOYMENT_FAILED", "El despliegue del Verifier fue revertido."); }
      await api("/api/deployment/progress", { method: "POST", headers: { "X-Traza-Network": config.network }, body: JSON.stringify({ planId: draft.planId, planToken: draft.planToken, kind: "verifier", transactionHash: draft.verifierTransaction }) });
      operation = "Registry";
      if (!draft.registryTransaction) {
        setStage("2 de 3 · Estimando el gas del Registry…");
        const gas = await estimateOperationGas(config, account, encodeDeployData({ abi: draft.registry.abi, bytecode: draft.registry.bytecode, args: [verifierReceipt.contractAddress] }));
        setStage("2 de 3 · Confirma el despliegue del Registry en tu wallet.");
        draft.registryTransaction = await (await wallet(account)).client.deployContract({ abi: draft.registry.abi, bytecode: draft.registry.bytecode, args: [verifierReceipt.contractAddress], gas });
        save(draft);
      }
      setStage("Esperando confirmación del Registry…");
      const registryReceipt = await client.waitForTransactionReceipt({ hash: draft.registryTransaction, timeout: 180_000 });
      if (registryReceipt.status !== "success" || !registryReceipt.contractAddress) { delete draft.registryTransaction; delete draft.rootTransaction; save(draft); throw new ApplicationError("DEPLOYMENT_FAILED", "El despliegue del Registry fue revertido."); }
      await api("/api/deployment/progress", { method: "POST", headers: { "X-Traza-Network": config.network }, body: JSON.stringify({ planId: draft.planId, planToken: draft.planToken, kind: "registry", transactionHash: draft.registryTransaction }) });
      operation = "raíz autorizada";
      if (!draft.rootTransaction) {
        setStage("3 de 3 · Estimando el gas de la raíz autorizada…");
        const gas = await estimateOperationGas(config, account, encodeFunctionData({ abi: draft.registry.abi, functionName: "setAuthorizedSourcesRoot", args: [BigInt(draft.root)] }), registryReceipt.contractAddress);
        setStage("3 de 3 · Confirma la publicación de la raíz autorizada.");
        const active = await wallet(account);
        const registry = getContract({ address: registryReceipt.contractAddress, abi: draft.registry.abi, client: { public: client, wallet: active.client } });
        draft.rootTransaction = await registry.write.setAuthorizedSourcesRoot([BigInt(draft.root)], { gas });
        save(draft);
      }
      setStage("Esperando confirmación de la raíz autorizada…");
      if ((await client.waitForTransactionReceipt({ hash: draft.rootTransaction, timeout: 180_000 })).status !== "success") { delete draft.rootTransaction; save(draft); throw new ApplicationError("DEPLOYMENT_FAILED", "La publicación de raíz fue revertida."); }
      operation = "guardar el despliegue";
      setStage("Confirma el permiso para guardar el despliegue verificado.");
      await authorizedRequest(config, "wallet-deploy", "/api/deployment/commit", { planId: draft.planId, planToken: draft.planToken, verifierTransaction: draft.verifierTransaction, registryTransaction: draft.registryTransaction, rootTransaction: draft.rootTransaction });
      window.sessionStorage.removeItem(storageKey(config.network, account));
      setStage("Despliegue confirmado y conectado al sitio.");
      await refresh();
    } catch (failure) { setError(errorMessage(failure)); setStage("El despliegue se detuvo en: " + operation + ". Puedes continuar con la misma cuenta y red."); }
    finally { setBusy(false); }
  }

  return <section className="panel deployment-panel"><div className="panel-heading"><Icon name="wallet"/><div><h2>Desplegar con {config.network === "amoy" ? "MetaMask en Polygon Amoy" : "tu wallet"}</h2><p>Verifier, Registry y raíz inicial: tres transacciones confirmadas por ti.</p></div></div>
    <p>La wallet conservará su clave privada y mostrará el gas antes de cada confirmación.{config.network === "amoy" && <> Necesitas POL de prueba en Amoy. Puedes obtenerlo en el <a className="text-button" href="https://faucet.polygon.technology/" target="_blank" rel="noreferrer">faucet indicado por Polygon</a>.</>}</p>
    <label className="checkbox"><input type="checkbox" checked={accepted} onChange={/* Confirma expresamente la fuente y ceremonia de desarrollo antes de preparar el ensayo. */ (event) => setAccepted(event.target.checked)} disabled={busy}/>Usar una fuente de desarrollo y el setup experimental del proyecto en esta red.</label>
    <button className="button primary" onClick={deploy} disabled={!account || !accepted || busy}>{busy ? "Despliegue en curso…" : plan ? "Continuar despliegue" : "Desplegar contratos con mi wallet"} <Icon name="arrow"/></button>
    {!account && <p className="helper">Abre el sitio en Chrome y pulsa Conectar wallet para utilizar MetaMask.</p>}
    {stage && <p className="processing" role="status">{busy && <span className="spinner"/>}{stage}</p>}{error && <Notice kind="error">{error}</Notice>}
    {plan?.verifierTransaction && <Value label="Transacción del Verifier" value={plan.verifierTransaction}/>}{plan?.registryTransaction && <Value label="Transacción del Registry" value={plan.registryTransaction}/>}
  </section>;
}
