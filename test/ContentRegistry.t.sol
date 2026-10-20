// SPDX-License-Identifier: MIT
/** Comprueba la administración y los rechazos del registro usando el verificador Groth16 real. */
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ContentRegistry} from "../contracts/ContentRegistry.sol";
import {Groth16Verifier} from "../contracts/Groth16Verifier.sol";

contract ContentRegistryTest is Test {
    // Datos públicos de ensayo; no contienen identidades ni claves privadas de fuentes.
    uint256 private constant ROOT = 17;
    uint256 private constant CONTENT = 23;
    uint256 private constant NULLIFIER = 29;
    address private constant OTHER = address(0xCAFE);
    address private constant NEXT_OWNER = address(0xBEEF);

    Groth16Verifier private verifier;
    ContentRegistry private registry;

    /// @notice Despliega el verificador generado y un registro nuevo para cada prueba.
    function setUp() public {
        verifier = new Groth16Verifier();
        registry = new ContentRegistry(address(verifier));
    }

    /// @notice Comprueba el administrador, el verificador y el estado inicial sin raíz habilitada.
    function test_ConstructorInicializaElRegistro() public view {
        assertEq(registry.owner(), address(this));
        assertEq(registry.pendingOwner(), address(0));
        assertEq(address(registry.verifier()), address(verifier));
        assertFalse(registry.rootEnabled());
        assertEq(registry.authorizedSourcesRoot(), 0);
        _assertUnchanged(CONTENT, NULLIFIER);
    }

    /// @notice Impide desplegar el registro con una dirección sin código ejecutable.
    function test_ConstructorRechazaVerificadorSinContrato() public {
        vm.expectRevert(ContentRegistry.InvalidVerifier.selector);
        new ContentRegistry(address(0));
        vm.expectRevert(ContentRegistry.InvalidVerifier.selector);
        new ContentRegistry(OTHER);
    }

    /// @notice Comprueba que sustituir una raíz rechaza la anterior para nuevos registros.
    function test_ActualizarRaizInvalidaLaAnterior() public {
        registry.setAuthorizedSourcesRoot(ROOT);
        assertTrue(registry.rootEnabled());
        assertEq(registry.authorizedSourcesRoot(), ROOT);
        registry.setAuthorizedSourcesRoot(ROOT + 1);
        assertEq(registry.authorizedSourcesRoot(), ROOT + 1);
        _expectRejection(_signals(), ContentRegistry.UnauthorizedRoot.selector);
    }

    /// @notice Comprueba la desactivación y la reactivación explícita de una raíz existente.
    function test_DesactivarRaizBloqueaNuevosRegistros() public {
        registry.setAuthorizedSourcesRoot(ROOT);
        registry.disableAuthorizedSourcesRoot();
        assertFalse(registry.rootEnabled());
        assertEq(registry.authorizedSourcesRoot(), ROOT);
        _expectRejection(_signals(), ContentRegistry.AuthorizationRootDisabled.selector);
        registry.setAuthorizedSourcesRoot(ROOT);
        assertTrue(registry.rootEnabled());
    }

    /// @notice Impide que una cuenta ajena cambie o desactive la autorización de fuentes.
    function test_SoloAdministradorGestionaRaices() public {
        vm.expectRevert(ContentRegistry.Unauthorized.selector);
        vm.prank(OTHER);
        registry.setAuthorizedSourcesRoot(ROOT);
        registry.setAuthorizedSourcesRoot(ROOT);
        vm.expectRevert(ContentRegistry.Unauthorized.selector);
        vm.prank(OTHER);
        registry.disableAuthorizedSourcesRoot();
        assertTrue(registry.rootEnabled());
        assertEq(registry.authorizedSourcesRoot(), ROOT);
    }

    /// @notice Rechaza la raíz vacía reservada y los valores que no pertenecen al campo.
    function test_RechazaRaicesMalCodificadas() public {
        uint256 modulus = registry.FIELD_MODULUS();
        vm.expectRevert(ContentRegistry.InvalidRoot.selector);
        registry.setAuthorizedSourcesRoot(0);
        vm.expectRevert(abi.encodeWithSelector(ContentRegistry.InvalidFieldElement.selector, 2));
        registry.setAuthorizedSourcesRoot(modulus);
        assertFalse(registry.rootEnabled());
    }

    /// @notice Exige aceptación desde la cuenta propuesta antes de transferir el control.
    function test_TransferenciaAdministrativaEnDosPasos() public {
        registry.transferOwnership(NEXT_OWNER);
        assertEq(registry.owner(), address(this));
        assertEq(registry.pendingOwner(), NEXT_OWNER);

        vm.expectRevert(ContentRegistry.Unauthorized.selector);
        vm.prank(NEXT_OWNER);
        registry.setAuthorizedSourcesRoot(ROOT);
        vm.expectRevert(ContentRegistry.Unauthorized.selector);
        vm.prank(OTHER);
        registry.acceptOwnership();

        vm.prank(NEXT_OWNER);
        registry.acceptOwnership();
        assertEq(registry.owner(), NEXT_OWNER);
        assertEq(registry.pendingOwner(), address(0));
        vm.expectRevert(ContentRegistry.Unauthorized.selector);
        registry.setAuthorizedSourcesRoot(ROOT);
        vm.prank(NEXT_OWNER);
        registry.setAuthorizedSourcesRoot(ROOT);
        assertTrue(registry.rootEnabled());
    }

    /// @notice Rechaza propuestas inválidas y transferencias iniciadas por cuentas ajenas.
    function test_RechazaTransferenciasNoAutorizadas() public {
        vm.expectRevert(ContentRegistry.InvalidAddress.selector);
        registry.transferOwnership(address(0));
        vm.expectRevert(ContentRegistry.InvalidAddress.selector);
        registry.transferOwnership(address(this));
        vm.expectRevert(ContentRegistry.Unauthorized.selector);
        vm.prank(OTHER);
        registry.transferOwnership(NEXT_OWNER);
        vm.expectRevert(ContentRegistry.Unauthorized.selector);
        registry.acceptOwnership();
        assertEq(registry.owner(), address(this));
        assertEq(registry.pendingOwner(), address(0));
    }

    /// @notice Exige configurar una raíz antes de aceptar cualquier solicitud.
    function test_RechazaRegistrosSinRaizActiva() public {
        _expectRejection(_signals(), ContentRegistry.AuthorizationRootDisabled.selector);
    }

    /// @notice Comprueba la versión, la raíz, la identidad y los tres componentes del dominio.
    function test_RechazaContextosYVersionesIncorrectos() public {
        registry.setAuthorizedSourcesRoot(ROOT);
        uint256[8] memory inputs = _signals();
        inputs[1] = 2;
        _expectRejection(inputs, ContentRegistry.UnsupportedProtocolVersion.selector);

        inputs = _signals();
        inputs[2] = ROOT + 1;
        _expectRejection(inputs, ContentRegistry.UnauthorizedRoot.selector);

        inputs = _signals();
        inputs[4] = uint256(uint160(OTHER));
        _expectRejection(inputs, ContentRegistry.WrongRegistrant.selector);

        inputs = _signals();
        inputs[5] = block.chainid + 1;
        _expectRejection(inputs, ContentRegistry.WrongChain.selector);

        inputs = _signals();
        inputs[6] = uint256(uint160(OTHER));
        _expectRejection(inputs, ContentRegistry.WrongRegistry.selector);

        inputs = _signals();
        inputs[7] += 1;
        _expectRejection(inputs, ContentRegistry.InvalidProtocolDomain.selector);
    }

    /// @notice Rechaza la copia de una autorización presentada desde otra cuenta.
    function test_RechazaRegistranteDistintoDelRemitente() public {
        registry.setAuthorizedSourcesRoot(ROOT);
        uint256[8] memory inputs = _signals();
        vm.expectRevert(ContentRegistry.WrongRegistrant.selector);
        vm.prank(OTHER);
        _registerEmptyProof(inputs);
        _assertUnchanged(CONTENT, NULLIFIER);
    }

    /// @notice Impide que truncar una dirección de más de 160 bits cambie el contexto probado.
    function test_RechazaDireccionesConBitsSuperiores() public {
        registry.setAuthorizedSourcesRoot(ROOT);
        uint256[8] memory inputs = _signals();
        inputs[4] += uint256(1) << 160;
        _expectRejection(inputs, ContentRegistry.WrongRegistrant.selector);
        inputs = _signals();
        inputs[6] += uint256(1) << 160;
        _expectRejection(inputs, ContentRegistry.WrongRegistry.selector);
    }

    /// @notice Comprueba el límite del campo para cada una de las ocho señales públicas.
    function test_RechazaTodasLasSenalesFueraDelCampo() public {
        registry.setAuthorizedSourcesRoot(ROOT);
        uint256 modulus = registry.FIELD_MODULUS();
        for (uint256 index = 0; index < 8; index++) {
            uint256[8] memory inputs = _signals();
            inputs[index] = modulus;
            vm.expectRevert(abi.encodeWithSelector(ContentRegistry.InvalidFieldElement.selector, index));
            _registerEmptyProof(inputs);
            _assertUnchanged(inputs[0], inputs[3]);
        }
    }

    /// @notice Rechaza una prueba nula mediante el verificador real sin consumir datos de registro.
    function test_PruebaInvalidaNoModificaElEstado() public {
        registry.setAuthorizedSourcesRoot(ROOT);
        _expectRejection(_signals(), ContentRegistry.InvalidProof.selector);
        assertEq(registry.authorizedSourcesRoot(), ROOT);
        assertTrue(registry.rootEnabled());
    }

    /// @notice Convierte en rechazo una prueba que contiene una coordenada de punto inválida.
    function test_RechazaPuntosDePruebaInvalidos() public {
        registry.setAuthorizedSourcesRoot(ROOT);
        uint256[2] memory pA;
        uint256[2][2] memory pB;
        uint256[2] memory pC;
        pA[0] = type(uint256).max;
        uint256[8] memory inputs = _signals();
        vm.expectRevert(ContentRegistry.InvalidProof.selector);
        registry.register(pA, pB, pC, inputs);
        _assertUnchanged(CONTENT, NULLIFIER);
    }

    /// @notice Devuelve un registro inexistente sin publicar datos de fuentes autorizadas.
    function test_ConsultaNegativaDevuelveValoresVacios() public view {
        ContentRegistry.ContentRecord memory record = registry.getRecord(CONTENT);
        assertFalse(record.exists);
        assertEq(record.contentHash, 0);
        assertEq(record.protocolVersion, 0);
        assertEq(record.registrant, address(0));
        assertEq(record.registeredAt, 0);
    }

    /// @notice Construye señales de contexto coherentes para aislar la condición que prueba cada caso.
    function _signals() private view returns (uint256[8] memory) {
        return [
            CONTENT,
            registry.PROTOCOL_VERSION(),
            ROOT,
            NULLIFIER,
            uint256(uint160(address(this))),
            block.chainid,
            uint256(uint160(address(registry))),
            registry.PROTOCOL_DOMAIN()
        ];
    }

    /// @notice Presenta una prueba nula al verificador real, manteniendo el contexto indicado.
    function _registerEmptyProof(uint256[8] memory inputs) private {
        uint256[2] memory pA;
        uint256[2][2] memory pB;
        uint256[2] memory pC;
        registry.register(pA, pB, pC, inputs);
    }

    /// @notice Comprueba el motivo del rechazo y que no aparezcan registros o autorizaciones consumidas.
    function _expectRejection(uint256[8] memory inputs, bytes4 errorSelector) private {
        vm.expectRevert(errorSelector);
        _registerEmptyProof(inputs);
        _assertUnchanged(inputs[0], inputs[3]);
    }

    /// @notice Confirma que una operación fallida no cree el contenido ni consuma el identificador público.
    function _assertUnchanged(uint256 contentHash, uint256 nullifier) private view {
        assertFalse(registry.getRecord(contentHash).exists);
        assertFalse(registry.usedNullifiers(nullifier));
    }
}
