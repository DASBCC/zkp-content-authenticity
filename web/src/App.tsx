/** Organiza la navegación, la conexión de wallet y el estado público compartido por la aplicación. */
import { useEffect, useState } from "react";
import type { Address } from "viem";
import type { Configuration } from "./types.ts";
import { activateLocalWallet, api, connectWallet, getSelectedNetwork, selectNetwork, usingLocalWallet, disconnectWallet, getConfiguration, switchNetwork } from "./services.ts";
import { errorMessage, short } from "./errors.ts";
import { Icon, Notice } from "./components.tsx";
import { Register } from "./Register.tsx";
import { Verify } from "./Verify.tsx";
import { Admin } from "./Admin.tsx";

// Las rutas corresponden a tareas del usuario; su selección también permite volver con el navegador.
const NAV = [{ id: "inicio", label: "Inicio", icon: "home" }, { id: "registrar", label: "Registrar contenido", icon: "upload" }, { id: "verificar", label: "Verificar contenido", icon: "search" }, { id: "administracion", label: "Administración", icon: "settings" }, { id: "funcionamiento", label: "Cómo funciona", icon: "book" }];

/** Explica las garantías del sistema con relaciones concretas y sin atribuir detección forense al protocolo. */
function About() {
  const items = [{ n: "01", title: "Integridad del archivo", text: "Poseidon calcula una huella de los bytes exactos. Cambiar el contenido, los metadatos o la codificación cambia la huella." }, { n: "02", title: "Autorización de fuente", text: "EdDSA/BabyJubJub vincula la autorización de una fuente admitida con el archivo, la cuenta, la cadena y el contrato." }, { n: "03", title: "Prueba de conocimiento cero", text: "Groth16 demuestra firma y pertenencia Merkle sin publicar la identidad de la fuente, su firma ni su ruta." }, { n: "04", title: "Registro y consulta", text: "El contrato verifica la prueba y consume la autorización. Las consultas posteriores recalculan la huella y leen el registro." }];
  return <><div className="page-title"><span className="eyebrow">DEL ARCHIVO A LA EVIDENCIA</span><h1>Cómo funciona Traza</h1><p>Cuatro relaciones distintas para una evidencia que puedes comprobar.</p></div><div className="about-grid">{items.map(/* Describe cada relación sin confundirla con la veracidad de una escena. */ (item) => <section className="panel" key={item.n}><span className="section-number">{item.n}</span><h2>{item.title}</h2><p>{item.text}</p></section>)}</div><section className="panel limits"><Icon name="info" size={28}/><h2>Un registro de autorización, no un detector universal.</h2><p>El sistema no determina si una escena ocurrió, si un contenido fue generado por IA ni si constituye un deepfake. Un resultado negativo indica ausencia de registro, y un error de conexión significa que no pudo completarse la consulta.</p><p>La confianza depende del conjunto de fuentes aprobado y de su administración. La privacidad criptográfica no elimina metadatos ni otras formas de correlación. El servicio de firma y prover conoce los datos privados; el archivo original permanece en tu dispositivo.</p><details className="technical"><summary>Parámetros del protocolo y seguridad</summary><p>Poseidon, EdDSA/BabyJubJub y Groth16 sobre BN254. Árbol de profundidad 8, capacidad 256, hojas ordenadas por identificador, posiciones vacías cero y padres Poseidon(izquierda, derecha).</p><p>Ocho señales públicas: contentHash, protocolVersion, authorizedSourcesRoot, nullifier, registrant, chainId, registryAddress y protocolDomain. La semilla EdDSA no forma parte del testigo.</p><p>El nullifier vincula fuente, nonce aleatorio de 248 bits, versión, cadena y registro. El contrato impide reutilizarlo y exige que el registrante coincida con quien envía la transacción. Una raíz revocada no acepta nuevos registros y conserva los históricos.</p><p>El setup local tiene un participante y es exclusivamente de desarrollo. Una infraestructura de producción requiere una ceremonia y una política de fuentes adecuadas.</p></details></section></>;
}

/** Presenta las acciones principales y la disponibilidad real de la infraestructura conectada. */
function Home({ config, navigate }: { config: Configuration; navigate: (page: string) => void }) {
  /** Abre el registro de contenido. */
  function register() { navigate("registrar"); }
  /** Abre la consulta pública de archivos. */
  function verify() { navigate("verificar"); }
  /** Abre la preparación y administración del sistema. */
  function administer() { navigate("administracion"); }
  return <><div className="home-heading"><span className="eyebrow">AUTENTICIDAD MULTIMEDIA · PROTOCOLO v{config.protocolVersion}</span><h1>Cada archivo.<br/>Una traza verificable.</h1><p>Vincula tus archivos con evidencia criptográfica de una fuente autorizada. Comprueba su registro, byte por byte.</p><div className="hero-actions"><button className="button primary" onClick={register}>Registrar contenido <Icon name="arrow"/></button><button className="button secondary" onClick={verify}>Verificar un archivo <Icon name="search"/></button></div><div className="hero-art" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="orbit orbit-three"/><div className="art-document"><span/><span/><span/><div><Icon name="shield" size={58}/></div></div><div className="art-chip chip-a"><Icon name="file"/> BYTES EXACTOS</div><div className="art-chip chip-b"><span className="status-dot"/> PRUEBA VERIFICABLE</div><div className="art-spark">✳</div></div></div>
    <div className="facts"><div><Icon name="shield"/><span>EdDSA + Poseidon<strong>Autorización criptográfica</strong></span></div><div><Icon name="link"/><span>Groth16 + Merkle<strong>Prueba privada de pertenencia</strong></span></div><div><Icon name="search"/><span>Consulta pública<strong>Sin wallet ni nueva ZKP</strong></span></div></div>
    <div className="section-title"><div><span className="eyebrow">TU ESPACIO DE TRABAJO</span><h2>De la fuente a la comprobación.</h2></div><span className="small-note">Imágenes · Audio · Video</span></div><div className="home-cards"><button className="task-card" onClick={register}><span className="task-icon"><Icon name="upload" size={27}/></span><span className="card-number">01</span><h3>Registra un archivo</h3><p>Obtén una autorización, genera una prueba y confirma su registro con tu cuenta.</p><span className="card-link">Crear evidencia <Icon name="arrow"/></span></button><button className="task-card" onClick={verify}><span className="task-icon"><Icon name="search" size={27}/></span><span className="card-number">02</span><h3>Comprueba un registro</h3><p>Selecciona un archivo y consulta si sus bytes exactos tienen evidencia aceptada.</p><span className="card-link">Consultar archivo <Icon name="arrow"/></span></button><button className="task-card" onClick={administer}><span className="task-icon"><Icon name="settings" size={27}/></span><span className="card-number">03</span><h3>Administra las fuentes</h3><p>Prepara el sistema, gestiona permisos y actualiza el conjunto de confianza.</p><span className="card-link">Abrir administración <Icon name="arrow"/></span></button></div>
    <div className="trust-strip"><Icon name="info"/><p>La evidencia acredita una autorización sobre unos bytes. La interpretación y veracidad del contenido requieren otras comprobaciones.</p><span>INVESTIGACIÓN APLICADA</span></div></>;
}

/** Mantiene una configuración central y escucha los cambios de cuenta o red de la wallet. */
export default function App() {
  const [page, setPage] = useState(window.location.hash.slice(1) || "inicio");
  const [config, setConfig] = useState<Configuration>();
  const [network, setNetwork] = useState(getSelectedNetwork);
  const [wallet, setWallet] = useState<{ address: Address; chainId: string }>();
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [localAccounts, setLocalAccounts] = useState<Address[]>([]);

  /** Actualiza la información pública a partir del despliegue y el contrato efectivos. */
  async function refresh() { const target = getSelectedNetwork(); try { const next = await getConfiguration(target); if (getSelectedNetwork() === target) { setConfig(next); setError(""); } } catch (failure) { if (getSelectedNetwork() === target) setError(errorMessage(failure)); } }
  /** Cambia el servicio de red y descarta estados de la cuenta de laboratorio antes de salir de localhost. */
  async function changeSelectedNetwork(event: React.ChangeEvent<HTMLSelectElement>) { const target = event.target.value; const laboratory = usingLocalWallet(); selectNetwork(target); setNetwork(target); setConfig(undefined); setLocalAccounts([]); if (laboratory) setWallet(undefined); await refresh(); }
  /** Cambia de pantalla y conserva una URL navegable. */
  function navigate(value: string) { window.location.hash = value; setPage(value); window.scrollTo({ top: 0 }); }
  /** Conecta la wallet elegida sin enviar claves privadas al servicio. */
  async function connect() { disconnectWallet(); setWallet(undefined); setLocalAccounts([]); setConnecting(true); setError(""); try { setWallet(await connectWallet()); } catch (failure) { setError(errorMessage(failure)); } finally { setConnecting(false); } }
  /** Descarta el acceso de la aplicación a la cuenta activa sin modificar su wallet. */
  function disconnect() { disconnectWallet(); setWallet(undefined); }
  /** Habilita de manera explícita la cuenta de laboratorio disponible únicamente en el nodo local. */
  async function local() { setConnecting(true); setError(""); try { await activateLocalWallet(); setWallet(await connectWallet()); setLocalAccounts((await api<{accounts: Address[]}>("/api/local-wallet/accounts")).accounts); } catch (failure) { setError(errorMessage(failure)); } finally { setConnecting(false); } }
  /** Selecciona otra cuenta existente del laboratorio para ensayar roles y permisos. */
  async function selectLocal(event: React.ChangeEvent<HTMLSelectElement>) { try { await activateLocalWallet(event.target.value as Address); setWallet(await connectWallet()); } catch (failure) { setError(errorMessage(failure)); } }
  /** Solicita a la wallet cambiar a la cadena de este despliegue. */
  async function changeNetwork() { if (!config) return; try { await switchNetwork(config); setWallet(await connectWallet()); } catch (failure) { setError(errorMessage(failure)); } }

  /** Carga la configuración y actualiza el estado cuando cambian cuenta, cadena o navegación. */
  useEffect(() => {
    void refresh();
    /** Sincroniza la navegación del historial del navegador. */
    function hashChanged() { setPage(window.location.hash.slice(1) || "inicio"); }
    /** Descarta permisos visuales al cambiar la cuenta o desconectar la wallet. */
    function accountsChanged(...args: unknown[]) { const accounts = args[0] as Address[]; setWallet(/* Conserva únicamente una cuenta que siga disponible. */ (current) => accounts?.[0] && current ? { ...current, address: accounts[0] } : undefined); }
    /** Refleja el identificador real informado por la wallet después de cambiar de red. */
    function chainChanged(...args: unknown[]) { setWallet(/* Actualiza la cadena sin asumir que coincide con el despliegue. */ (current) => current ? { ...current, chainId: BigInt(args[0] as string).toString() } : undefined); }
    window.addEventListener("hashchange", hashChanged); window.ethereum?.on?.("accountsChanged", accountsChanged); window.ethereum?.on?.("chainChanged", chainChanged);
    return () => { window.removeEventListener("hashchange", hashChanged); window.ethereum?.removeListener?.("accountsChanged", accountsChanged); window.ethereum?.removeListener?.("chainChanged", chainChanged); };
  }, []);

  return <div className="app-shell"><aside className="sidebar"><a className="brand" href="#inicio"><span className="brand-symbol"><Icon name="shield" size={25}/></span><span>traza<span className="brand-period">.</span><small>AUTENTICIDAD MULTIMEDIA</small></span></a><div className="nav-label">ESPACIO DE TRABAJO</div><nav aria-label="Navegación principal">{NAV.map(/* Mantiene nombres de navegación accesibles y una sola pantalla activa. */ (item) => <a key={item.id} href={"#" + item.id} className={page === item.id ? "active" : ""} aria-current={page === item.id ? "page" : undefined}><Icon name={item.icon}/>{item.label}{page === item.id && <span className="nav-dot"/>}</a>)}</nav><div className="sidebar-bottom"><div className="network-box"><span className={"status-dot " + (!config?.deploymentReady ? "pending" : "")}/><div><strong>{config?.deploymentReady ? "Registro disponible" : "Preparación pendiente"}</strong><span>{config ? config.network + " · " + config.chainId : "Conectando servicio"}</span></div></div><p>Criptografía que puedes comprobar.<br/>Evidencia que puedes consultar.</p><span className="sidebar-foot">PROYECTO DE INVESTIGACIÓN / v1</span></div></aside><div className="workspace"><header className="topbar"><div className="breadcrumb">Traza <span>/</span> {NAV.find(/* Obtiene el título de la ubicación activa. */ (item) => item.id === page)?.label ?? "Inicio"}</div><div className="wallet-actions"><select className="network-select" aria-label="Red del protocolo" value={network} onChange={changeSelectedNetwork}><option value="localhost">Red local</option><option value="amoy">Polygon Amoy</option></select>{wallet && localAccounts.length > 0 && <select className="account-select" aria-label="Cuenta experimental local" value={wallet.address} onChange={selectLocal}>{localAccounts.map(/* Permite ensayar permisos con direcciones públicas del nodo, sin copiar claves. */ (address, index) => <option key={address} value={address}>Cuenta {index + 1} · {short(address, 4)}</option>)}</select>}{wallet && <button className="text-button local-account" onClick={disconnect}>Desconectar</button>}{config?.experimental && <span className="experimental">{config.network === "amoy" ? "CLAVES DE DESARROLLO" : "EXPERIMENTAL LOCAL"}</span>}{!wallet && config?.localWalletAvailable && <button className="text-button local-account" onClick={local} disabled={connecting}>Usar cuenta experimental</button>}<button className="button wallet-button" onClick={connect} disabled={connecting}><Icon name="wallet"/>{connecting ? "Conectando…" : wallet ? short(wallet.address, 5) : "Conectar wallet"}</button></div></header><main>
      {error && <Notice kind="error">{error} <button className="text-button" onClick={refresh}>Reintentar conexión</button></Notice>}
      {wallet && config && wallet.chainId !== config.chainId && <Notice kind="error">La wallet está en la cadena {wallet.chainId}. Este registro utiliza {config.chainId}. <button className="text-button" onClick={changeNetwork}>Cambiar de red</button></Notice>}
      {!config ? <div className="loading-screen"><span className="spinner"/><h1>Conectando tu espacio…</h1><p>Consultando la configuración del protocolo.</p></div> : page === "registrar" ? <Register key={config.network} config={config} account={wallet?.address}/> : page === "verificar" ? <Verify key={config.network} config={config}/> : page === "administracion" ? <Admin key={config.network + (wallet?.address ?? "public")} config={config} account={wallet?.address} refresh={refresh}/> : page === "funcionamiento" ? <About/> : <Home config={config} navigate={navigate}/>}
    </main><footer><span>Traza · Autenticidad multimedia</span><span>Firmas autorizadas. Pruebas privadas. Consultas públicas.</span></footer></div></div>;
}
