/** Valida y convierte enteros de campo, direcciones y bytes; serializa datos criptográficos sin perder precisión. */

// Módulo primo del campo escalar de BN254, usado por las huellas y las coordenadas BabyJubJub.
export const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
// Orden del subgrupo primo BabyJubJub: el escalar S de una firma debe ser menor que este valor.
export const SUBGROUP_ORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;

/**
 * Acepta BigInt o texto decimal canónico y valida su rango sin aplicar reducción modular.
 * Entradas. Valor de campo, nombre opcional para diagnósticos y límite superior exclusivo opcional.
 * Salida. BigInt no negativo y menor que el límite.
 */
export function parseField(value, name = "field", limit = FIELD_MODULUS) {
  if (typeof value !== "bigint" && (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))) {
    throw new TypeError(`${name}: se requiere BigInt o una cadena decimal canónica`);
  }
  const result = BigInt(value);
  if (result < 0n || result >= limit) throw new RangeError(`${name}: fuera de rango`);
  return result;
}

/**
 * Exige que un objeto tenga exactamente las propiedades indicadas, sin campos extra ni faltantes.
 * Entradas. Objeto candidato, lista exacta de claves y nombre para el diagnóstico.
 * Salida. Sin valor de retorno. Lanza TypeError si la forma es incorrecta.
 */
export function exactKeys(value, keys, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(/* Detecta si falta una propiedad obligatoria. Entradas. Nombre de una clave obligatoria. Salida. true si el objeto carece de la propiedad propia. */ (key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`${name}: estructura inválida; campos: ${keys.join(", ")}`);
  }
}

/**
 * Valida una dirección EVM de 20 bytes con prefijo 0x y devuelve su forma en minúsculas.
 * Entradas. Dirección hexadecimal candidata y nombre para el diagnóstico.
 * Salida. Cadena con la dirección EVM canónica en minúsculas.
 */
export function canonicalAddress(value, name) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new TypeError(`${name}: se requiere una dirección EVM de 20 bytes con prefijo 0x`);
  }
  return value.toLowerCase();
}

/**
 * Interpreta los bytes como un entero sin signo, empezando por el byte de mayor peso.
 * Entradas. Secuencia de bytes Uint8Array.
 * Salida. Entero BigInt en orden big-endian.
 */
export function bytesToBigIntBE(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Se requieren bytes Uint8Array");
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/**
 * Serializa objetos a JSON convirtiendo cada BigInt en texto decimal para conservar su precisión.
 * Entradas. Valor serializable e indentación opcional, de dos espacios por defecto.
 * Salida. Texto JSON o undefined si el valor raíz no tiene representación JSON.
 */
export function stringifyCrypto(value, space = 2) {
  return JSON.stringify(value, /* Convierte únicamente los valores BigInt a texto decimal. Entradas. Clave JSON ignorada y valor que se serializa. Salida. Cadena decimal para BigInt o el valor original. */ (_key, item) => typeof item === "bigint" ? item.toString(10) : item, space);
}
