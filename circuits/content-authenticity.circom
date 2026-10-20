/** Demuestra una autorización EdDSA/Poseidon de una fuente incluida en una raíz Merkle, con contexto y número de uso único. */

pragma circom 2.2.0;

include "circomlib/circuits/eddsaposeidon.circom";

// La entrada principal se genera a partir de los parámetros centralizados de src/protocol.mjs.
template ContentAuthenticity(depth, version, domain) {
    // Estas ocho señales son públicas y su orden es parte de la versión del protocolo.
    signal input contentHash;
    signal input protocolVersion;
    signal input authorizedSourcesRoot;
    signal input nullifier;
    signal input registrant;
    signal input chainId;
    signal input registryAddress;
    signal input protocolDomain;

    // La identidad de la fuente, su firma y su ruta permanecen dentro del testigo privado.
    signal input sourceId;
    signal input nonce;
    signal input publicKeyX;
    signal input publicKeyY;
    signal input R8x;
    signal input R8y;
    signal input S;
    signal input merklePathElements[depth];
    signal input merklePathIndices[depth];

    protocolVersion === version;
    protocolDomain === domain;
    component registrantBits = Num2Bits(160);
    registrantBits.in <== registrant;
    component registryBits = Num2Bits(160);
    registryBits.in <== registryAddress;
    component chainBits = Num2Bits(64);
    chainBits.in <== chainId;
    component chainZero = IsZero();
    chainZero.in <== chainId;
    chainZero.out === 0;
    component sourceZero = IsZero();
    sourceZero.in <== sourceId;
    sourceZero.out === 0;
    component nonceBits = Num2Bits(248);
    nonceBits.in <== nonce;
    component nonceZero = IsZero();
    nonceZero.in <== nonce;
    nonceZero.out === 0;

    // Se conserva exactamente la relación de autorización implementada en la Fase 1.
    component base = Poseidon(4);
    base.inputs[0] <== contentHash;
    base.inputs[1] <== protocolVersion;
    base.inputs[2] <== sourceId;
    base.inputs[3] <== nonce;
    component context = Poseidon(4);
    context.inputs[0] <== registrant;
    context.inputs[1] <== chainId;
    context.inputs[2] <== registryAddress;
    context.inputs[3] <== protocolDomain;
    component message = Poseidon(2);
    message.inputs[0] <== base.out;
    message.inputs[1] <== context.out;

    // Los puntos deben pertenecer a BabyJubJub y no pueden representar su punto neutro.
    component keyCheck = BabyCheck();
    keyCheck.x <== publicKeyX;
    keyCheck.y <== publicKeyY;
    component keyZero = IsZero();
    keyZero.in <== publicKeyX;
    keyZero.out === 0;
    component rCheck = BabyCheck();
    rCheck.x <== R8x;
    rCheck.y <== R8y;
    component rZero = IsZero();
    rZero.in <== R8x;
    rZero.out === 0;
    component signature = EdDSAPoseidonVerifier();
    signature.enabled <== 1;
    signature.Ax <== publicKeyX;
    signature.Ay <== publicKeyY;
    signature.R8x <== R8x;
    signature.R8y <== R8y;
    signature.S <== S;
    signature.M <== message.out;

    // La hoja vincula el identificador privado de la fuente con su clave autorizada.
    component leaf = Poseidon(3);
    leaf.inputs[0] <== sourceId;
    leaf.inputs[1] <== publicKeyX;
    leaf.inputs[2] <== publicKeyY;
    signal nodes[depth + 1];
    signal left[depth];
    signal right[depth];
    component parents[depth];
    nodes[0] <== leaf.out;
    for (var i = 0; i < depth; i++) {
        // Índice 0: nodo actual a la izquierda; índice 1: nodo actual a la derecha.
        merklePathIndices[i] * (merklePathIndices[i] - 1) === 0;
        left[i] <== nodes[i] + merklePathIndices[i] * (merklePathElements[i] - nodes[i]);
        right[i] <== merklePathElements[i] + merklePathIndices[i] * (nodes[i] - merklePathElements[i]);
        parents[i] = Poseidon(2);
        parents[i].inputs[0] <== left[i];
        parents[i].inputs[1] <== right[i];
        nodes[i + 1] <== parents[i].out;
    }
    nodes[depth] === authorizedSourcesRoot;

    // El contrato consume esta huella para impedir reutilizar la autorización en la misma cadena y registro.
    component consumed = Poseidon(5);
    consumed.inputs[0] <== sourceId;
    consumed.inputs[1] <== nonce;
    consumed.inputs[2] <== protocolVersion;
    consumed.inputs[3] <== chainId;
    consumed.inputs[4] <== registryAddress;
    consumed.out === nullifier;
}
