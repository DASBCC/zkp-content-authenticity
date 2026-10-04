/** Reproduce las relaciones Poseidon y comprueba una firma para validar la compatibilidad entre JavaScript y Circom. */

pragma circom 2.2.0;

include "circomlib/circuits/eddsaposeidon.circom";

// Comprueba que las huellas de autorización y la firma generadas en JavaScript satisfacen el circuito.
template AuthorizationCompatibility() {
    // Firma, clave pública en coordenadas y mensaje M que debe estar firmado.
    signal input enabled;
    signal input Ax;
    signal input Ay;
    signal input R8x;
    signal input R8y;
    signal input S;
    signal input M;
    // Datos necesarios para reconstruir la autorización base y el contexto esperado.
    signal input contentHash;
    signal input protocolVersion;
    signal input sourceId;
    signal input nonce;
    signal input registrant;
    signal input chainId;
    signal input registryAddress;
    signal input protocolDomain;
    signal input authorizationHash;
    signal input operationContext;

    // Impide desactivar la comprobación de la firma en esta prueba.
    enabled === 1;
    // Compromiso base: contenido, versión del protocolo, fuente y nonce.
    component base = Poseidon(4);
    base.inputs[0] <== contentHash;
    base.inputs[1] <== protocolVersion;
    base.inputs[2] <== sourceId;
    base.inputs[3] <== nonce;
    base.out === authorizationHash;

    // Compromiso del contexto: registrante, red, registro y dominio.
    component context = Poseidon(4);
    context.inputs[0] <== registrant;
    context.inputs[1] <== chainId;
    context.inputs[2] <== registryAddress;
    context.inputs[3] <== protocolDomain;
    context.out === operationContext;

    // Une ambos compromisos y exige que el resultado sea el mensaje M firmado.
    component signedMessage = Poseidon(2);
    signedMessage.inputs[0] <== base.out;
    signedMessage.inputs[1] <== context.out;
    signedMessage.out === M;

    // Verifica EdDSA/Poseidon con la clave pública y la firma recibidas.
    component verifier = EdDSAPoseidonVerifier();
    verifier.enabled <== enabled;
    verifier.Ax <== Ax;
    verifier.Ay <== Ay;
    verifier.R8x <== R8x;
    verifier.R8y <== R8y;
    verifier.S <== S;
    verifier.M <== M;
}

component main = AuthorizationCompatibility();
