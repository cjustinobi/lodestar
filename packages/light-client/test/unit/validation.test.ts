import bls from "@chainsafe/bls";
import {Tree} from "@chainsafe/persistent-merkle-tree";
import {createBeaconConfig} from "@lodestar/config";
import {chainConfig} from "@lodestar/config/default";
import {
  EPOCHS_PER_SYNC_COMMITTEE_PERIOD,
  FINALIZED_ROOT_GINDEX,
  NEXT_SYNC_COMMITTEE_GINDEX,
  SLOTS_PER_EPOCH,
  SYNC_COMMITTEE_SIZE,
} from "@lodestar/params";
import {altair, ssz} from "@lodestar/types";
import {beforeAll, describe, expect, it, vi} from "vitest";
import {LightClientSnapshotFast, SyncCommitteeFast} from "../../src/types.js";
import {assertValidLightClientUpdate} from "../../src/validation.js";
import {defaultBeaconBlockHeader, getSyncAggregateSigningRoot, signAndAggregate} from "../utils/utils.js";

describe("validation", () => {
  // In browser test this process is taking more time than default 2000ms
  // specially on the CI
  vi.setConfig({testTimeout: 15000});

  const genValiRoot = Buffer.alloc(32, 9);
  const config = createBeaconConfig(chainConfig, genValiRoot);

  let update: altair.LightClientUpdate;
  let snapshot: LightClientSnapshotFast;

  beforeAll(() => {
    // Update slot must > snapshot slot
    // attestedHeaderSlot must == updateHeaderSlot + 1
    const snapshotHeaderSlot = 1;
    const updateHeaderSlot = EPOCHS_PER_SYNC_COMMITTEE_PERIOD * SLOTS_PER_EPOCH + 1;
    const attestedHeaderSlot = updateHeaderSlot + 1;

    const skBytes: Buffer[] = [];
    for (let i = 0; i < SYNC_COMMITTEE_SIZE; i++) {
      const buffer = Buffer.alloc(32, 0);
      buffer.writeInt16BE(i + 1, 30); // Offset to ensure the SK is less than the order
      skBytes.push(buffer);
    }
    const sks = skBytes.map((skBytes) => bls.SecretKey.fromBytes(skBytes));
    const pks = sks.map((sk) => sk.toPublicKey());
    const pubkeys = pks.map((pk) => pk.toBytes());

    // Create a sync committee with the keys that will sign the `syncAggregate`
    const nextSyncCommittee: altair.SyncCommittee = {
      pubkeys,
      aggregatePubkey: bls.aggregatePublicKeys(pubkeys),
    };

    const finalizedState = ssz.altair.BeaconState.defaultViewDU();

    // finalized header must have stateRoot to finalizedState
    const finalizedHeader = defaultBeaconBlockHeader(updateHeaderSlot);
    finalizedHeader.beacon.stateRoot = finalizedState.hashTreeRoot();

    // attestedState must have `finalizedHeader` as finalizedCheckpoint
    const attestedState = ssz.altair.BeaconState.defaultViewDU();
    attestedState.finalizedCheckpoint = ssz.phase0.Checkpoint.toViewDU({
      epoch: 0,
      root: ssz.altair.LightClientHeader.hashTreeRoot(finalizedHeader),
    });

    // attested state must contain next sync committees
    attestedState.nextSyncCommittee = ssz.altair.SyncCommittee.toViewDU(nextSyncCommittee);

    // attestedHeader must have stateRoot to attestedState
    const attestedHeader = defaultBeaconBlockHeader(attestedHeaderSlot);
    attestedHeader.beacon.stateRoot = attestedState.hashTreeRoot();

    // Creates proofs for nextSyncCommitteeBranch and finalityBranch rooted in attested state
    const nextSyncCommitteeBranch = new Tree(attestedState.node).getSingleProof(BigInt(NEXT_SYNC_COMMITTEE_GINDEX));
    const finalityBranch = new Tree(attestedState.node).getSingleProof(BigInt(FINALIZED_ROOT_GINDEX));

    const signingRoot = getSyncAggregateSigningRoot(config, attestedHeader);
    const syncAggregate = signAndAggregate(signingRoot, sks);

    const syncCommittee: SyncCommitteeFast = {
      pubkeys: pks,
      aggregatePubkey: bls.PublicKey.fromBytes(bls.aggregatePublicKeys(pubkeys)),
    };

    update = {
      attestedHeader,
      nextSyncCommittee,
      nextSyncCommitteeBranch,
      finalizedHeader,
      finalityBranch,
      syncAggregate,
      signatureSlot: updateHeaderSlot,
    };

    snapshot = {
      header: defaultBeaconBlockHeader(snapshotHeaderSlot),
      currentSyncCommittee: syncCommittee,
      nextSyncCommittee: syncCommittee,
    };
  });

  it("should validate valid update", () => {
    expect(() => assertValidLightClientUpdate(config, snapshot.nextSyncCommittee, update)).not.toThrow();
  });
});
