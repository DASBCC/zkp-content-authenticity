// SPDX-License-Identifier: MIT
/** Registra contenidos mediante pruebas Groth16 y administra una única raíz de fuentes autorizadas. */
pragma solidity ^0.8.28;

/// @notice Interfaz del verificador generado a partir del circuito y su clave de verificación.
interface IGroth16Verifier {
    /// @notice Comprueba una prueba Groth16 con las ocho señales públicas del protocolo.
    function verifyProof(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[8] calldata publicSignals
    ) external view returns (bool);
}

contract ContentRegistry {
    // Límite exclusivo de las señales públicas en el campo escalar de BN254.
    uint256 public constant FIELD_MODULUS =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Versión y dominio deben coincidir con los parámetros del circuito compilado.
    uint256 public constant PROTOCOL_VERSION = 1;
    uint256 public constant PROTOCOL_DOMAIN =
        50360535517347656596214192851187233225966461402695475318446782001;

    struct ContentRecord {
        uint256 contentHash;
        uint256 protocolVersion;
        address registrant;
        uint256 registeredAt;
        bool exists;
    }

    /// @notice Verificador inmutable de las pruebas de autenticación.
    IGroth16Verifier public immutable verifier;
    /// @notice Cuenta que puede actualizar la autorización de fuentes.
    address public owner;
    /// @notice Cuenta que debe aceptar la transferencia administrativa pendiente.
    address public pendingOwner;
    /// @notice Única raíz de fuentes admitida para nuevos registros.
    uint256 public authorizedSourcesRoot;
    /// @notice Indica si la raíz actual está habilitada.
    bool public rootEnabled;
    /// @notice Indica si una autorización pública ya fue consumida.
    mapping(uint256 => bool) public usedNullifiers;
    // Los registros sólo contienen datos públicos y permanecen después de una revocación.
    mapping(uint256 => ContentRecord) private records;

    error Unauthorized();
    error InvalidAddress();
    error InvalidVerifier();
    error InvalidRoot();
    error InvalidFieldElement(uint256 index);
    error UnsupportedProtocolVersion();
    error AuthorizationRootDisabled();
    error UnauthorizedRoot();
    error WrongRegistrant();
    error WrongChain();
    error WrongRegistry();
    error InvalidProtocolDomain();
    error ContentAlreadyRegistered();
    error NullifierAlreadyUsed();
    error InvalidProof();

    event ContentRegistered(
        uint256 indexed contentHash,
        address indexed registrant,
        uint256 protocolVersion,
        uint256 timestamp
    );
    event AuthorizedSourcesRootUpdated(uint256 indexed previousRoot, uint256 indexed newRoot);
    event AuthorizedSourcesRootDisabled(uint256 indexed root);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed proposedOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /// @notice Vincula el registro con un verificador desplegado y asigna la administración al creador.
    constructor(address verifierAddress) {
        if (verifierAddress.code.length == 0) revert InvalidVerifier();
        verifier = IGroth16Verifier(verifierAddress);
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    /// @dev Restringe las operaciones administrativas al propietario actual.
    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    /// @notice Reemplaza la raíz activa; la raíz anterior deja de autorizar nuevos registros.
    function setAuthorizedSourcesRoot(uint256 newRoot) external onlyOwner {
        if (newRoot == 0) revert InvalidRoot();
        if (newRoot >= FIELD_MODULUS) revert InvalidFieldElement(2);
        uint256 previousRoot = authorizedSourcesRoot;
        authorizedSourcesRoot = newRoot;
        rootEnabled = true;
        emit AuthorizedSourcesRootUpdated(previousRoot, newRoot);
    }

    /// @notice Desactiva nuevos registros sin eliminar la raíz ni el historial existente.
    function disableAuthorizedSourcesRoot() external onlyOwner {
        rootEnabled = false;
        emit AuthorizedSourcesRootDisabled(authorizedSourcesRoot);
    }

    /// @notice Propone un nuevo propietario, que debe aceptar la administración desde su propia cuenta.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0) || newOwner == owner) revert InvalidAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Completa la transferencia administrativa únicamente desde la cuenta propuesta.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner || pendingOwner == address(0)) revert Unauthorized();
        address previousOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, msg.sender);
    }

    /// @notice Registra una huella sólo tras comprobar su contexto, autorización y prueba Groth16.
    /// @dev Señales: contenido, versión, raíz, nullifier, registrante, cadena, contrato y dominio.
    function register(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[8] calldata publicSignals
    ) external {
        for (uint256 index = 0; index < publicSignals.length; index++) {
            if (publicSignals[index] >= FIELD_MODULUS) revert InvalidFieldElement(index);
        }
        if (publicSignals[1] != PROTOCOL_VERSION) revert UnsupportedProtocolVersion();
        if (!rootEnabled) revert AuthorizationRootDisabled();
        if (publicSignals[2] != authorizedSourcesRoot) revert UnauthorizedRoot();
        if (publicSignals[4] != uint256(uint160(msg.sender))) revert WrongRegistrant();
        if (publicSignals[5] != block.chainid) revert WrongChain();
        if (publicSignals[6] != uint256(uint160(address(this)))) revert WrongRegistry();
        if (publicSignals[7] != PROTOCOL_DOMAIN) revert InvalidProtocolDomain();

        uint256 contentHash = publicSignals[0];
        uint256 nullifier = publicSignals[3];
        if (records[contentHash].exists) revert ContentAlreadyRegistered();
        if (usedNullifiers[nullifier]) revert NullifierAlreadyUsed();

        // Una llamada fallida al verificador tampoco puede consumir la autorización.
        try verifier.verifyProof(pA, pB, pC, publicSignals) returns (bool valid) {
            if (!valid) revert InvalidProof();
        } catch {
            revert InvalidProof();
        }

        usedNullifiers[nullifier] = true;
        records[contentHash] = ContentRecord({
            contentHash: contentHash,
            protocolVersion: publicSignals[1],
            registrant: msg.sender,
            registeredAt: block.timestamp,
            exists: true
        });
        emit ContentRegistered(contentHash, msg.sender, publicSignals[1], block.timestamp);
    }

    /// @notice Devuelve los datos públicos de un contenido; exists indica si existe un registro.
    function getRecord(uint256 contentHash) external view returns (ContentRecord memory) {
        return records[contentHash];
    }
}
