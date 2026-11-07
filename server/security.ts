/** Autentica solicitudes mediante desafíos de wallet de un solo uso vinculados a origen, acción y datos. */

import { randomBytes, randomUUID } from "node:crypto";
import { keccak256, stringToHex } from "viem";
import type { Address, Hex } from "viem";
import { canonicalAddress, stringifyCrypto } from "../src/encoding.mjs";

// Los desafíos vencen pronto y las cuotas limitan el trabajo criptográfico solicitado al servidor.
export const CHALLENGE_TTL = 120_000;
export const JOB_TTL = 600_000;
export const MAX_BODY_BYTES = 128 * 1024;

/** Representa un error público controlado sin incorporar entradas privadas ni excepciones del proveedor. */
export class ServiceError extends Error {
  /**
   * Crea un error con código estable y estado HTTP, sin datos de solicitudes privadas.
   * Entradas. Código público, mensaje y estado HTTP opcional, de 400 por defecto.
   * Salida. Instancia de ServiceError para responder al cliente.
   */
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

/**
 * Calcula un compromiso estable del cuerpo para impedir cambiar datos después de firmar el desafío.
 * Entradas. Valor del cuerpo de una solicitud.
 * Salida. Huella Keccak-256 hexadecimal del JSON canonizado.
 */
export function payloadDigest(value: unknown): Hex {
  /**
   * Ordena las propiedades de cada objeto sin alterar el orden de los arreglos.
   * Entradas. Valor JSON o estructura anidada del cuerpo.
   * Salida. Valor equivalente con las claves de objetos ordenadas.
   */
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") return Object.fromEntries(Object.keys(item).sort().map(/* Canoniza cada propiedad por su nombre. Entradas. Nombre de propiedad del objeto. Salida. Par con el nombre y su valor canonizado de forma recursiva. */ (key) => [key, canonical((item as Record<string, unknown>)[key])]));
    return item;
  }
  return keccak256(stringToHex(stringifyCrypto(canonical(value))));
}

/**
 * Genera tokens de capacidad para controlar el acceso a trabajos y planes.
 * Entradas. Ningún argumento.
 * Salida. Token de 32 bytes aleatorios codificado en Base64 URL.
 */
export function capability() { return randomBytes(32).toString("base64url"); }

/** Mantiene desafíos limitados, con expiración y firma EIP-191 comprobada por el cliente público. */
export class ChallengeStore {
  private challenges = new Map<string, { address: Address; action: string; digest: Hex; message: string; expires: number }>();

  /**
   * Registra una solicitud y devuelve el mensaje exacto que deberá confirmar su wallet.
   * Entradas. Cuenta, acción, cuerpo, origen, cadena y dirección del registro.
   * Salida. Objeto con identificador, mensaje para firmar y vencimiento en milisegundos.
   */
  issue(address: string, action: string, payload: unknown, origin: string, chainId: string, registry: string) {
    const account = canonicalAddress(address, "cuenta") as Address;
    for (const [id, entry] of this.challenges) if (entry.expires < Date.now()) this.challenges.delete(id);
    if (this.challenges.size >= 200) throw new ServiceError("BUSY", "Hay demasiadas solicitudes; inténtalo de nuevo en unos minutos.", 429);
    const id = randomUUID();
    const expires = Date.now() + CHALLENGE_TTL;
    const digest = payloadDigest(payload);
    const message = ["TRAZA — Permiso para una operación", "Origen: " + origin, "Cuenta: " + account,
      "Cadena: " + chainId, "Registro: " + registry.toLowerCase(), "Acción: " + action,
      "Datos: " + digest, "Desafío: " + id, "Vence: " + new Date(expires).toISOString()].join("\n");
    this.challenges.set(id, { address: account, action, digest, message, expires });
    return { id, message, expiresAt: expires };
  }

  /**
   * Consume el desafío antes de verificar para impedir replay incluso ante peticiones concurrentes.
   * Entradas. Identificador, firma, acción, cuerpo y función verificadora de la wallet.
   * Salida. Promesa de la dirección del firmante autenticado.
   */
  async consume(id: string, signature: Hex, action: string, payload: unknown, verify: (address: Address, message: string, signature: Hex) => Promise<boolean>) {
    const challenge = this.challenges.get(id);
    this.challenges.delete(id);
    if (!challenge || challenge.expires < Date.now() || challenge.action !== action || challenge.digest !== payloadDigest(payload)) throw new ServiceError("AUTH_EXPIRED", "El permiso venció o sus datos cambiaron. Solicita otro permiso.", 401);
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature) || signature.length > 4096) throw new ServiceError("AUTH_INVALID", "La firma de la wallet no es válida.", 401);
    let valid = false;
    try { valid = await verify(challenge.address, challenge.message, signature); } catch { valid = false; }
    if (!valid) throw new ServiceError("AUTH_INVALID", "La firma no corresponde a la cuenta autorizada.", 401);
    return challenge.address;
  }
}
