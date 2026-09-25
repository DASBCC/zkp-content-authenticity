// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract ContentRegistry {

    struct ContentRecord {
        uint256 contentHash;
        uint256 sourceId;
        uint256 protocolVersion;
        address registrant;
        uint256 registeredAt;
        bool exists;
    }

    struct AuthorizedSource {
        bytes publicKey;
        bool active;
    }

    // Registro de contenidos por su contentHash.
    mapping(uint256 => ContentRecord) private records;

    // Fuentes autorizadas identificadas mediante sourceId.
    mapping(uint256 => AuthorizedSource) private authorizedSources;

    // Nonces que ya fueron utilizados por cada fuente.
    mapping(uint256 => mapping(uint256 => bool)) private usedNonces;

    function getRecord(
        uint256 contentHash
    )
        external
        view
        returns (ContentRecord memory)
    {
        return records[contentHash];
    }

    function getAuthorizedSource(
        uint256 sourceId
    )
        external
        view
        returns (
            bytes memory publicKey,
            bool active
        )
    {
        AuthorizedSource storage source = authorizedSources[sourceId];

        return (
            source.publicKey,
            source.active
        );
    }

    function isNonceUsed(
        uint256 sourceId,
        uint256 nonce
    )
        external
        view
        returns (bool)
    {
        return usedNonces[sourceId][nonce];
    }
}