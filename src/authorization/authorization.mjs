import { buildPoseidon } from "circomlibjs";

export async function calculateAuthorizationHash({
  contentHash,
  protocolVersion,
  sourceId,
  nonce,
  registrant,
}) {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const result = poseidon([
    BigInt(contentHash),
    BigInt(protocolVersion),
    BigInt(sourceId),
    BigInt(nonce),
    BigInt(registrant),
  ]);

  return F.toObject(result).toString();
}