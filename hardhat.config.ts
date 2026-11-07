/** Configura las redes existentes y la conexión local o Polygon Amoy sin mezclar claves EVM y claves de fuente. */
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

// Node carga las variables locales sin incorporar otra dependencia de configuración.
if (existsSync(".env")) loadEnvFile(".env");

// Orden de las claves privadas EVM sobre secp256k1; no es el campo BabyJubJub del protocolo.
const EVM_PRIVATE_KEY_ORDER = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

/**
 * Valida una URL HTTP sin mostrar posibles credenciales del proveedor en los mensajes de error.
 * Entradas. URL candidata, URL de respaldo y nombre de la variable para el diagnóstico.
 * Salida. URL HTTP o HTTPS elegida como texto.
 */
function resolveRpc(value: string | undefined, fallback: string, name: string): string {
  const resolved = value?.trim() || fallback;
  try {
    const parsed = new URL(resolved);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    return resolved;
  } catch {
    throw new Error(name + " debe ser una URL HTTP o HTTPS válida");
  }
}

/**
 * Convierte el identificador local al número entero seguro que exige la configuración de Hardhat.
 * Entradas. Sin argumentos. Lee CHAIN_ID del entorno y usa 31337 por defecto.
 * Salida. Identificador positivo como entero seguro de JavaScript.
 */
function resolveLocalChainId(): number {
  const value = process.env.CHAIN_ID?.trim() || "31337";
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("CHAIN_ID debe ser un entero decimal positivo");
  const chainId = Number(value);
  if (!Number.isSafeInteger(chainId)) throw new Error("CHAIN_ID excede el rango entero seguro de Hardhat");
  return chainId;
}

/**
 * Normaliza exclusivamente la clave de la billetera de despliegue y rechaza formatos o escalares inválidos.
 * Entradas. Sin argumentos. Lee DEPLOYER_PRIVATE_KEY del entorno.
 * Salida. Arreglo vacío si la variable está ausente o arreglo con la clave EVM normalizada.
 */
function resolveDeploymentAccounts(): string[] {
  const value = process.env.DEPLOYER_PRIVATE_KEY?.trim();
  if (!value) return [];
  const normalized = /^0x/i.test(value) ? "0x" + value.slice(2) : "0x" + value;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("DEPLOYER_PRIVATE_KEY debe contener 32 bytes hexadecimales");
  }
  const scalar = BigInt(normalized);
  if (scalar === 0n || scalar >= EVM_PRIVATE_KEY_ORDER) {
    throw new Error("DEPLOYER_PRIVATE_KEY no es un escalar EVM válido");
  }
  return [normalized];
}

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.34",
        // El destino Paris evita depender de instrucciones EVM recientes al desplegar en otras redes.
        settings: { evmVersion: "paris" },
      },
      production: {
        version: "0.8.34",
        settings: {
          evmVersion: "paris",
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 31337,
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
    },
    localhost: {
      type: "http",
      chainType: "l1",
      url: resolveRpc(process.env.RPC_URL, "http://127.0.0.1:8545", "RPC_URL"),
      chainId: resolveLocalChainId(),
      accounts: "remote",
    },
    amoy: {
      type: "http",
      chainType: "l1",
      url: resolveRpc(process.env.AMOY_RPC_URL, "https://polygon-amoy.drpc.org", "AMOY_RPC_URL"),
      chainId: 80002,
      accounts: resolveDeploymentAccounts(),
    },
  },
});
