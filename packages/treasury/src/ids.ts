/**
 * Hedera has three ways to name the same account: `0.0.x`, the "long-zero" EVM
 * address derived from it, and (for ECDSA accounts) an EVM alias. Mixing them up
 * is one of the most common Hedera bugs, so every conversion lives here.
 */

const ENTITY_ID = /^(\d+)\.(\d+)\.(\d+)$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface EntityId {
  shard: bigint;
  realm: bigint;
  num: bigint;
}

export function parseEntityId(id: string): EntityId {
  const match = ENTITY_ID.exec(id.trim());
  if (!match) throw new Error(`Not a Hedera entity id: "${id}"`);
  return { shard: BigInt(match[1]!), realm: BigInt(match[2]!), num: BigInt(match[3]!) };
}

export function isEntityId(value: string): boolean {
  return ENTITY_ID.test(value.trim());
}

export function isEvmAddress(value: string): boolean {
  return EVM_ADDRESS.test(value.trim());
}

/** `0.0.19264` → `0x0000000000000000000000000000000000004b40`. */
export function toLongZeroAddress(id: string): `0x${string}` {
  const { shard, realm, num } = parseEntityId(id);
  if (shard >= 2n ** 32n || realm >= 2n ** 64n || num >= 2n ** 64n) {
    throw new Error(`Entity id out of range for a long-zero address: ${id}`);
  }
  const hex =
    shard.toString(16).padStart(8, "0") + realm.toString(16).padStart(16, "0") + num.toString(16).padStart(16, "0");
  return `0x${hex}`;
}

/** True when the address is a long-zero address (first 12 bytes zero), i.e. it encodes an entity id. */
export function isLongZeroAddress(address: string): boolean {
  return isEvmAddress(address) && /^0x0{24}/i.test(address);
}

/** Inverse of {@link toLongZeroAddress}. Throws for EVM aliases, which need a mirror-node lookup instead. */
export function fromLongZeroAddress(address: string): string {
  if (!isEvmAddress(address)) throw new Error(`Not an EVM address: "${address}"`);
  const hex = address.slice(2);
  const shard = BigInt(`0x${hex.slice(0, 8)}`);
  const realm = BigInt(`0x${hex.slice(8, 24)}`);
  const num = BigInt(`0x${hex.slice(24)}`);
  if (shard !== 0n || realm !== 0n) {
    throw new Error(`${address} is an EVM alias, not a long-zero address; resolve it through the mirror node`);
  }
  return `${shard}.${realm}.${num}`;
}
