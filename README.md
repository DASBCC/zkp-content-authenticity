# Autenticidad multimedia — Fase 1

Implementación criptográfica fuera de cadena para autenticar los bytes de imágenes, audio y video mediante Poseidon y firmas EdDSA sobre BabyJubJub. Permite generar claves de fuente, calcular huellas, construir autorizaciones, firmarlas, verificarlas y exportar entradas para Circom.

Esta fase no requiere RPC, wallet, fondos ni aplicación web. Los contratos y la configuración Hardhat preexistentes se conservan.

## Tecnologías y requisitos

| Componente | Versión utilizada |
| --- | --- |
| Node.js | 26.13.0 en la validación; mínimo 22.13.0 |
| npm | 11.20.0 en la validación |
| circomlibjs / circomlib | 0.1.7 / 2.0.5 |
| circom2 | paquete 0.2.23; compilador Circom 2.2.3 en WASM |
| snarkjs | 0.7.6 |
| Hardhat / toolbox viem | 3.17.0 / 5.0.7 |
| TypeScript / viem | 6.0.3 / 2.56.8 |

Se utiliza npm y se versiona package-lock.json. No hace falta instalar Circom globalmente, Rust ni un compilador nativo para ejecutar las pruebas criptográficas. Hardhat descarga Solidity en la primera compilación del contrato existente.

Ed25519 fue reemplazado porque utiliza una curva y una construcción diferentes de EdDSAPoseidonVerifier. Sus claves PEM y firmas no son compatibles. La implementación usa exclusivamente buildEddsa(), prv2pub(), signPoseidon() y verifyPoseidon() de circomlibjs.

BabyJubJub es una curva de Edwards sobre el campo escalar de BN254. Las claves públicas y R8 se intercambian como dos coordenadas; S es un escalar del subgrupo. Poseidon permite expresar las mismas relaciones mediante los componentes de circomlib.

APIs verificadas: [circomlibjs 0.1.7](https://github.com/iden3/circomlibjs/tree/v0.1.7), [EdDSAPoseidonVerifier en circomlib 2.0.5](https://github.com/iden3/circomlib/blob/v2.0.5/circuits/eddsaposeidon.circom), [Hardhat 3](https://hardhat.org/llms.txt).

## Instalación

Desde la raíz del repositorio:

~~~shell
npm ci
npm run build
npm run crypto:test
npm test
~~~

build compila el proyecto existente con Hardhat y ejecuta tsc --noEmit. crypto:test ejecuta todas las pruebas criptográficas, incluida la compilación Circom, generación de witness y comprobación de restricciones R1CS. test agrega la suite Hardhat preexistente.

La instalación inicial necesita acceso a npm y GitHub por la dependencia existente forge-std. El hashing, las firmas, la verificación y las pruebas criptográficas no realizan llamadas de red.

## Estructura

~~~text
src/
  hashing.mjs                Hash de archivos, bytes y streams
  poseidon.mjs               Instancia Poseidon compartida
  authorization.mjs          Autorizaciones, paquetes y entradas del prover
  eddsa.mjs                  Claves públicas y EdDSA/Poseidon
  encoding.mjs               Campo, decimales, direcciones y JSON
  key-management.mjs         Generación, validación y carga de secretos
scripts/
  crypto-cli.mjs             CLI único: hash, keygen, authorization, sign, verify
  send-op-tx.ts              Script preexistente
test/
  hashing-authorization.test.mjs
  eddsa.test.mjs             Firmas, claves y paquetes
  integration.test.mjs       CLI y compatibilidad con Circom
  fixtures.mjs               Utilidades de ensayo compartidas
  circuits/authorization.circom
  vectors/crypto-v1.json
samples/
  prueba.txt
  prueba-modificada.txt
  operation.json
keys/                        Claves generadas, excluidas de Git
output/                      Resultados locales, excluidos de Git
contracts/                   Contrato preexistente
hardhat.config.ts            Configuración preexistente
~~~

## Protocolo de contentHash

Se leen los bytes exactos sin decodificar ni transformar los formatos multimedia.

1. Dividir en bloques consecutivos de 31 bytes.
2. Completar solo el último bloque incompleto con 0x00 a la derecha.
3. Interpretar cada bloque como entero unsigned big-endian.
4. Inicializar el estado con la longitud original en bytes.
5. Absorber cada bloque mediante Poseidon de dos entradas.

~~~text
h0 = Poseidon(fileLength, block0)
hi = Poseidon(hAnterior, blockActual)
contentHash = hFinal

archivo vacío: contentHash = Poseidon(0, 0)
~~~

Un múltiplo exacto de 31 no recibe un bloque adicional. Un archivo de un byte 0xab utiliza un bloque 0xab seguido de 30 bytes cero. La longitud original diferencia archivos que solo difieren en ceros finales. La decisión para el archivo vacío está fijada en los vectores y las pruebas.

calculateContentHash lee buffers de 64 KiB sobre un único descriptor, mantiene un bloque de 31 bytes y devuelve BigInt. No acumula los bloques ni carga todo el archivo. Comprueba la longitud leída y cambios en tamaño/fechas del archivo durante la lectura. hashContentStream exige la longitud original y rechaza streams más cortos o largos.

La firma y la verificación reutilizan la misma función. No se utiliza SHA-256 como huella principal.

## Autorización y contexto

Las relaciones y su orden exacto son:

~~~text
authorizationHash = Poseidon(contentHash, protocolVersion, sourceId, nonce)

operationContext = Poseidon(
    registrant, chainId, registryAddress, protocolDomain
)

signedAuthorizationHash = Poseidon(authorizationHash, operationContext)
~~~

Se firma el elemento de campo signedAuthorizationHash con eddsa.signPoseidon(seed, eddsa.F.e(signedAuthorizationHash)). No se firma su texto decimal.

Codificación canónica:

- Campo p = 21888242871839275222246405745257275088548364400416034343698204186575808495617.
- Escalar: 0 <= S < 2736030358979909402780800718157159386076813972158567259200215660948447373041.
- La API acepta BigInt o cadenas decimales unsigned sin espacios, signo ni ceros iniciales, salvo el propio "0". Rechaza Number, notación exponencial y hexadecimal para valores de campo.
- Los valores se validan antes de llamar a circomlibjs; nunca se reducen silenciosamente módulo p.
- Las direcciones EVM tienen prefijo 0x y exactamente 40 dígitos hexadecimales. Se normalizan a minúsculas y se utiliza su entero unsigned de 160 bits en Poseidon.
- chainId es positivo y menor que p.
- El dominio de esta versión es el entero big-endian de los bytes ASCII de "zkp-content-authenticity:v1": 50360535517347656596214192851187233225966461402695475318446782001.
- Todos los enteros de paquetes JSON y witness son cadenas decimales.
- Coordenadas sin compresión: publicKey = [Ax, Ay], signature = { R8: [R8x, R8y], S }.
- Claves públicas y R8 deben pertenecer al subgrupo BabyJubJub y no ser el punto neutro. Se rechazan estructuras con campos adicionales.

samples/operation.json especifica protocolVersion, sourceId, nonce y context. Sus direcciones y chainId son datos de ensayo. Para una operación posterior, el llamador debe proporcionar chainId y registryAddress obtenidos de la configuración efectiva de esa operación. Esta fase solo los procesa como datos criptográficos, sin conexiones ni valores de red implícitos. La verificación exige la operación esperada de manera independiente.

Cada autorización debe usar un nonce único por fuente. Su consumo persistente y la asociación de sourceId con una clave de confianza corresponden a fases posteriores; la firma por sí sola no detecta la repetición de una operación idéntica.

## Variables y claves

La identidad de la fuente autorizada y una wallet EVM son independientes. La semilla EdDSA autoriza contenido y no se utiliza para firmar transacciones.

~~~shell
npm run crypto:keygen
~~~

Se crean keys/source-private.json y keys/source-public.json. La semilla se genera con node:crypto.randomBytes(32). El archivo privado contiene un identificador de formato y una semilla de 32 bytes en hexadecimal minúsculo sin prefijo 0x. No es un escalar de campo ni una clave PEM. El comando muestra solamente rutas y nunca sobrescribe archivos existentes.

Para otras rutas:

~~~shell
npm run crypto:keygen -- --out keys/source-2-private.json --public-key keys/source-2-public.json
~~~

Usar --key para cargar el archivo privado. Alternativamente, SOURCE_EDDSA_PRIVATE_KEY acepta la semilla hexadecimal. Configurar ambos orígenes produce error. No se utilizan PRIVATE_KEY ni variables de wallet.

.env.example contiene un marcador ficticio y comentarios de formato. Opcionalmente, copiarlo a .env y completar la semilla generada localmente. En PowerShell:

~~~powershell
Copy-Item .env.example .env
~~~

Node solo carga ese archivo si se solicita expresamente:

~~~shell
node --env-file=.env scripts/crypto-cli.mjs sign --file samples/prueba.txt --operation samples/operation.json --out output/authorization-env.json
~~~

.env y sus variantes, keys/, output/ y .crypto-build/ están excluidos de Git. Excluir cualquier otra ruta privada antes de generar secretos. Se solicita modo 0600 al crear archivos; en Windows deben usarse ACL apropiadas y evitar carpetas compartidas. Los archivos privados locales se guardan sin cifrado.

La semilla no se imprime ni se añade al paquete, al prover, al witness o a una aplicación pública. Las funciones para generar/cargar secretos se importan separadamente desde src/key-management.mjs. Se limpian las copias temporales administradas por las funciones; JavaScript no garantiza borrado completo de memoria.

## Comandos completos

Ejecutar desde la raíz. Cada comando valida sus parámetros. Los archivos de salida se crean sin sobrescribir resultados anteriores: usar otra ruta al repetir una ejecución.

~~~shell
npm run crypto:hash -- --file samples/prueba.txt

npm run crypto:keygen

npm run crypto:authorization -- --file samples/prueba.txt --operation samples/operation.json --out output/base-authorization.json

npm run crypto:sign -- --file samples/prueba.txt --operation samples/operation.json --key keys/source-private.json --out output/authorization.json

npm run crypto:verify -- --file samples/prueba.txt --operation samples/operation.json --authorization output/authorization.json --public-key keys/source-public.json --witness output/witness-inputs.json

npm run crypto:verify -- --file samples/prueba-modificada.txt --operation samples/operation.json --authorization output/authorization.json --public-key keys/source-public.json

npm run crypto:test
~~~

La primera verificación devuelve valid: true. El archivo modificado devuelve valid: false y código 2. Los errores de argumentos, archivos, formatos o paquetes inconsistentes devuelven 1. El éxito devuelve 0. Todos los comandos admiten --help. Los nombres npm se conservan y delegan en un único archivo; también puede ejecutarse node scripts/crypto-cli.mjs --help.

La clave de --public-key debe obtenerse de una fuente de confianza independiente. No basta confiar en la clave incluida en el paquete: cualquier persona puede generar un par y firmar contenido.

La verificación recalcula los bytes, reconstruye los hashes, compara la operación esperada, compara la clave pública de confianza y verifica la firma. El paquete contiene format, authorization, publicKey y signature. El witness se exporta solo después de verificar contra la operación y la clave esperadas.

## API para el prover y consumidores posteriores

~~~javascript
import {
  signContentAuthorization,
  verifyContentAuthorization,
  serializeAuthorizationPackage,
  deserializeAuthorizationPackage,
  exportProverInputs,
} from "./src/authorization.mjs";
import { calculateContentHash } from "./src/hashing.mjs";
import { loadPrivateKey } from "./src/key-management.mjs";

const contentHash = await calculateContentHash(filePath);
const seed = await loadPrivateKey({ filePath: privateKeyPath });
try {
  const signed = await signContentAuthorization({ contentHash, ...operation }, seed);
  const json = await serializeAuthorizationPackage(signed);
  const restored = await deserializeAuthorizationPackage(json);
  const valid = await verifyContentAuthorization(restored, {
    contentHash, operation, publicKey: trustedSourcePublicKey,
  });
  if (valid) {
    const inputs = await exportProverInputs(restored);
  }
} finally {
  seed.fill(0);
}
~~~

| Función | Entrada y salida |
| --- | --- |
| hashContentBytes(bytes) | Uint8Array -> Promise<BigInt> |
| hashContentStream(chunks, fileLength) | Iterable/AsyncIterable de Uint8Array y longitud BigInt/decimal -> Promise<BigInt> |
| calculateContentHash(path) | Archivo local -> Promise<BigInt> |
| createAuthorization(input) | contentHash, protocolVersion, sourceId, nonce, context -> datos normalizados y tres hashes |
| derivePublicKey(seed) | Semilla Uint8Array de 32 bytes -> coordenadas BigInt |
| signAuthorizationHash(message, seed) | signedAuthorizationHash y semilla -> R8 y S BigInt |
| verifyAuthorizationSignature(message, signature, publicKey) | Promise<boolean>; entradas mal formadas lanzan error |
| serializeSignature / deserializeSignature | Firma validada <-> JSON decimal estable |
| signContentAuthorization(input, seed) | Datos de autorización y semilla -> paquete firmado |
| verifyContentAuthorization(package, expected) | Exige contentHash, operation y publicKey independientes |
| serializeAuthorizationPackage / deserializeAuthorizationPackage | Validan esquema, representaciones y hashes internos |
| exportVerifierInputs(message, signature, publicKey) | enabled, Ax, Ay, R8x, R8y, S y M como cadenas |
| exportProverInputs(package) | Entradas del verificador más datos auxiliares |

exportVerifierInputs asigna M = signedAuthorizationHash y enabled = "1". exportProverInputs agrega contentHash, protocolVersion, sourceId, nonce, registrant, chainId, registryAddress, protocolDomain, authorizationHash y operationContext, sin secretos.

El circuito de prueba conecta estos datos con EdDSAPoseidonVerifier y comprueba las tres relaciones Poseidon. El circuito completo posterior deberá imponer las reglas de registro, rangos y confianza correspondientes. Esta fase no genera una prueba ZK completa de autenticidad ni verifica los bytes multimedia dentro del circuito de prueba.

## Pruebas y vectores

~~~shell
npm run crypto:test
npm run build
npm test
~~~

La suite cubre determinismo, cambio de un byte, vacío, tamaños 1/30/31/32/62, big-endian, padding, longitud, cortes de stream, archivos mayores de 2 MiB, datos base y contexto de autorización, firmas válidas/alteradas, claves incorrectas, serialización, secretos, comandos y rechazo de valores no canónicos.

test/vectors/crypto-v1.json contiene bytes incrementales 0..61, hashes de frontera, una semilla pública exclusivamente de ensayo, clave derivada, firma y los tres hashes de autorización. Los resultados se fijaron directamente con circomlibjs 0.1.7. No utilizar esa semilla pública para autorizar contenido real.

La prueba Circom compila con el compilador WASM incluido, calcula un witness real y lo comprueba contra R1CS mediante snarkjs. Exige rechazo al alterar firma, mensaje o contexto. La prueba de integración utiliza rutas nativas de Node para que el compilador WASI escriba correctamente en Windows.

## Seguridad y límites pendientes

La firma acredita que una clave autorizó unos bytes y un contexto. No establece por sí sola la veracidad del contenido ni la confianza de una fuente.

Quedan para fases posteriores: gestión persistente de fuentes y nonces, circuito completo del protocolo, generación de pruebas ZK, integración del registro y aplicación web.

La auditoría realizada durante esta implementación detectó 31 avisos en el árbol de dependencias instalado: 17 altos, 2 moderados y 12 bajos. Incluye dependencias transitivas de herramientas existentes y de snarkjs. Algunas soluciones propuestas requieren cambiar versiones mayores de Hardhat. Se conservan las versiones compatibles del proyecto; la actualización de ese árbol queda pendiente. Ejecutar npm audit para consultar su estado actual.

## Problemas habituales

| Problema | Solución |
| --- | --- |
| EEXIST al crear claves/resultados | Elegir una ruta nueva; no sobrescribir claves privadas. |
| Falta la clave de fuente | Pasar --key o cargar SOURCE_EDDSA_PRIVATE_KEY, nunca ambos. |
| Formato de clave incompatible | Generar una semilla con crypto:keygen; no usar PEM Ed25519 anteriores. |
| Decimal no canónico | Usar cadenas unsigned sin 0x, espacios ni ceros iniciales; evitar Number. |
| valid: false | Comprobar bytes, clave pública de confianza, nonce y contexto completo. |
| El archivo cambió durante el hashing | Leer un archivo que permanezca estable durante el procesamiento. |
| Solidity no disponible | La primera compilación Hardhat necesita descargar solc y escribir su caché. |
| Circom global no encontrado | crypto:test usa el compilador WASM fijado en package-lock.json. |
| .env no se carga | Usar node --env-file=.env; npm no carga .env automáticamente. |
