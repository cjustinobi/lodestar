import path from "node:path";
import {ProofType, SingleProof, Tree} from "@chainsafe/persistent-merkle-tree";
import {fromHexString, toHexString} from "@chainsafe/ssz";
import {ACTIVE_PRESET} from "@lodestar/params";
import {InputType} from "@lodestar/spec-test-util";
import {BeaconStateAllForks} from "@lodestar/state-transition";
import {ssz} from "@lodestar/types";
import {verifyMerkleBranch} from "@lodestar/utils";
import {expect} from "vitest";
import {ethereumConsensusSpecsTests} from "../specTestVersioning.js";
import {specTestIterator} from "../utils/specTestIterator.js";
import {RunnerType, TestRunnerFn} from "../utils/types.js";

const merkle: TestRunnerFn<MerkleTestCase, IProof> = (fork) => {
  return {
    testFunction: (testcase) => {
      const {proof: specTestProof, state} = testcase;
      const stateRoot = state.hashTreeRoot();
      const leaf = fromHexString(specTestProof.leaf);
      const branch = specTestProof.branch.map((item) => fromHexString(item));
      const leafIndex = Number(specTestProof.leaf_index);
      const depth = Math.floor(Math.log2(leafIndex));
      const verified = verifyMerkleBranch(leaf, branch, depth, leafIndex % 2 ** depth, stateRoot);
      expect(verified).toEqualWithMessage(true, "invalid merkle branch");

      const lodestarProof = new Tree(state.node).getProof({
        gindex: specTestProof.leaf_index,
        type: ProofType.single,
      }) as SingleProof;

      return {
        leaf: toHexString(lodestarProof.leaf),
        leaf_index: lodestarProof.gindex,
        branch: lodestarProof.witnesses.map(toHexString),
      };
    },

    options: {
      inputTypes: {
        state: {type: InputType.SSZ_SNAPPY as const, treeBacked: true as const},
        proof: InputType.YAML as const,
      },
      getSszTypes: () => ({
        state: ssz[fork].BeaconState,
      }),
      timeout: 10000,
      getExpected: (testCase) => testCase.proof,
      expectFunc: (_testCase, expected, actual) => {
        expect(actual).toEqualWithMessage(expected, "incorrect proof");
      },
      // Do not manually skip tests here, do it in packages/beacon-node/test/spec/presets/index.test.ts
    },
  };
};

type MerkleTestCase = {
  meta?: any;
  state: BeaconStateAllForks;
  proof: IProof;
};

interface IProof {
  leaf: string;
  leaf_index: bigint;
  branch: string[];
}

specTestIterator(path.join(ethereumConsensusSpecsTests.outputDir, "tests", ACTIVE_PRESET), {
  merkle: {type: RunnerType.default, fn: merkle},
});
