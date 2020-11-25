import {ContainerType, ListType} from "@chainsafe/ssz";
import * as t from "../../../types/phase1/types";
import {Phase1Generator} from "./interface";

export const ShardBlock: Phase1Generator<ContainerType<t.ShardBlock>, "Shard"> = (params, types, phase1Types) => {
  return new ContainerType({
    fields: {
      shardParentRoot: types.Root,
      beaconParentRoot: types.Root,
      slot: types.Slot,
      shard: phase1Types.Shard,
      proposerIndex: types.ValidatorIndex,
      body: new ListType({
        elementType: types.Uint8,
        limit: params.phase1.MAX_SHARD_BLOCK_SIZE,
      }),
    },
  });
};

export const SignedShardBlock: Phase1Generator<ContainerType<t.SignedShardBlock>, "ShardBlock"> = (
  params,
  types,
  phase1Types
) => {
  return new ContainerType({
    fields: {
      message: phase1Types.ShardBlock,
      signature: types.BLSSignature,
    },
  });
};

export const ShardBlockHeader: Phase1Generator<ContainerType<t.ShardBlockHeader>, "Shard"> = (
  params,
  types,
  phase1Types
) => {
  return new ContainerType({
    fields: {
      shardParentRoot: types.Root,
      beaconParentRoot: types.Root,
      slot: types.Slot,
      shard: phase1Types.Shard,
      proposerIndex: types.ValidatorIndex,
      bodyRoot: types.Root,
    },
  });
};

export const ShardState: Phase1Generator<ContainerType<t.ShardState>> = (params, types) => {
  return new ContainerType({
    fields: {
      slot: types.Slot,
      gasprice: types.Gwei,
      latestBlockRoot: types.Root,
    },
  });
};

export const ShardTransition: Phase1Generator<ContainerType<t.ShardTransition>, "ShardState"> = (
  params,
  types,
  phase1Types
) => {
  return new ContainerType({
    fields: {
      startSlot: types.Slot,
      shardBlockLengths: new ListType({
        elementType: types.Uint64,
        limit: params.phase1.MAX_SHARD_BLOCKS_PER_ATTESTATION,
      }),
      shardDataRoots: new ListType({
        elementType: types.Bytes32,
        limit: params.phase1.MAX_SHARD_BLOCKS_PER_ATTESTATION,
      }),
      shardStates: new ListType({
        elementType: phase1Types.ShardState,
        limit: params.phase1.MAX_SHARD_BLOCKS_PER_ATTESTATION,
      }),
      proposerSignatureAggregate: types.BLSSignature,
    },
  });
};

export const CompactCommittee: Phase1Generator<ContainerType<t.CompactCommittee>> = (params, types) => {
  return new ContainerType({
    fields: {
      pubkeys: new ListType({
        elementType: types.BLSPubkey,
        limit: params.MAX_VALIDATORS_PER_COMMITTEE,
      }),
      compactValidators: new ListType({
        elementType: types.Uint64,
        limit: params.MAX_VALIDATORS_PER_COMMITTEE,
      }),
    },
  });
};
