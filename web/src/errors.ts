/** Traduce errores de wallet, red, contratos y servicios sin incluir testigos ni respuestas privadas. */

// Los nombres coinciden con los errores reales del contrato y con los estados del servicio.
const MESSAGES: Record<string, string> = {
  WalletMissing: "No se encontró una wallet EVM. Instala una wallet compatible, como MetaMask.",
  WalletDisconnected: "Conecta tu wallet para continuar.", WrongChain: "La wallet está conectada a otra red. Cambia a la red del registro.",
  WrongRegistrant: "La cuenta actual no corresponde al registrante de esta prueba.", WrongRegistry: "La prueba corresponde a otro contrato.",
  ContentAlreadyRegistered: "Estos bytes ya tienen un registro aceptado.", DUPLICATE_CONTENT: "Estos bytes ya tienen un registro aceptado.",
  NullifierAlreadyUsed: "La autorización ya fue utilizada. Solicita una nueva.", AuthorizationRootDisabled: "La raíz de autorización está deshabilitada.",
  UnauthorizedRoot: "El conjunto autorizado cambió. Genera una nueva prueba.", InvalidProof: "El verificador rechazó la prueba criptográfica.",
  UnsupportedProtocolVersion: "La versión del protocolo no es compatible.", InvalidProtocolDomain: "El dominio del protocolo no corresponde.",
  Unauthorized: "La cuenta no tiene permisos administrativos.", ContractMissing: "El contrato no está disponible en la red seleccionada.",
  RPC_UNAVAILABLE: "No se pudo consultar la blockchain. Comprueba la conexión y el nodo.",
};

/** Mantiene código y mensaje públicos para diferenciar fallas operativas de resultados negativos. */
export class ApplicationError extends Error {
  /** Asocia una clasificación pública con un mensaje comprensible para la interfaz. */
  constructor(public code: string, message?: string) { super(message ?? MESSAGES[code] ?? "No se pudo completar la operación."); }
}

/** Recupera únicamente clasificaciones conocidas de errores anidados de viem o del proveedor. */
export function errorMessage(error: unknown): string {
  const pending: unknown[] = [error];
  const visited = new Set<object>();
  for (let index = 0; pending.length && index < 32; index++) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    const item = current as { code?: number | string; name?: string; message?: string; shortMessage?: string; details?: string; data?: { errorName?: string }; cause?: unknown; error?: unknown; originalError?: unknown };
    if (item instanceof ApplicationError) return item.message;
    if (item.code === 4001 || item.name === "UserRejectedRequestError") return "La operación fue rechazada en la wallet. Puedes volver a intentarlo.";
    const detail = [item.message, item.shortMessage, item.details].filter(/* Examina únicamente textos de diagnóstico sin mostrarlos en la interfaz. */ (value) => typeof value === "string").join(" ");
    if (item.name?.includes("InsufficientFunds") || /insufficient funds/i.test(detail)) return "La wallet no tiene saldo suficiente para pagar el gas de la red seleccionada.";
    if (item.name === "GasLimitTooHighError" || /gas(?: limit)?(?: is)? too high|exceeds (?:the )?(?:block|transaction) gas limit|gas limit exceeds/i.test(detail)) return "El límite de gas solicitado supera el permitido por la red. Vuelve a intentar el despliegue para calcularlo de nuevo.";
    if (item.name === "FeeCapTooHighError" || /max fee per gas.*too high|gas price.*too high/i.test(detail)) return "La comisión por unidad de gas es demasiado alta. Revisa la comisión propuesta en MetaMask antes de volver a intentar.";
    const name = item.data?.errorName;
    if (name && MESSAGES[name]) return MESSAGES[name];
    pending.push(item.cause, item.data, item.error, item.originalError);
  }
  return "No se pudo completar la operación. Comprueba el servicio, el nodo y la configuración de la wallet.";
}

/** Acorta un identificador público solo para presentarlo; nunca cambia el valor usado en las operaciones. */
export function short(value: string, size = 8) { return value.length > size * 2 + 3 ? value.slice(0, size) + "…" + value.slice(-size) : value; }
