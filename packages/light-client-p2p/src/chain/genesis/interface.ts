import {ssz} from "@lodestar/types";
import {CachedBeaconStateAllForks} from "@lodestar/state-transition";
import {CompositeViewDU, VectorCompositeType} from "@chainsafe/ssz";
import {Eth1Block} from "@lodestar/beacon-node/eth1/interface";

export interface IGenesisResult {
  state: CachedBeaconStateAllForks;
  depositTree: CompositeViewDU<VectorCompositeType<typeof ssz.Root>>;
  block: Eth1Block;
}

export interface IGenesisBuilder {
  waitForGenesis: () => Promise<IGenesisResult>;
}
