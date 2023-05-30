import {expect} from "chai";
import deepmerge from "deepmerge";
import {createForkConfig} from "@lodestar/config";
import {NetworkName, networksChainConfig} from "@lodestar/config/networks";
import {UNVERIFIED_RESPONSE_CODE} from "../../../src/constants.js";
import {eth_getTransactionCount} from "../../../src/verified_requests/eth_get_transaction_count.js";
import getTransactionCountCase1 from "../../fixtures/sepolia/eth_getTransactionCount.json" assert {type: "json"};
import {generateReqHandlerOptionsMock} from "../../mocks/request_handler.js";

const testCases = [getTransactionCountCase1];

describe("verified_requests / eth_getTransactionCount", () => {
  for (const t of testCases) {
    describe(t.label, () => {
      it("should return the valid json-rpc response for a valid account", async () => {
        const testCase = deepmerge({}, t);
        const config = createForkConfig(networksChainConfig[testCase.network as NetworkName]);
        const options = generateReqHandlerOptionsMock(testCase, config);

        const response = await eth_getTransactionCount({
          ...options,
          payload: {
            ...testCase.request,
            params: testCase.request.params as [string, string],
          },
        });

        expect(response).to.eql(testCase.response);
      });

      it("should return the json-rpc response with error for an invalid account", async () => {
        const testCase = deepmerge({}, t);
        delete testCase.dependentRequests[0].response.result.accountProof[0];

        const config = createForkConfig(networksChainConfig[testCase.network as NetworkName]);
        const options = generateReqHandlerOptionsMock(testCase, config);

        const response = await eth_getTransactionCount({
          ...options,
          payload: {
            ...testCase.request,
            params: testCase.request.params as [string, string],
          },
        });

        expect(response).to.eql({
          jsonrpc: "2.0",
          id: testCase.request.id,
          error: {code: UNVERIFIED_RESPONSE_CODE, message: "eth_getTransactionCount request can not be verified."},
        });
      });
    });
  }
});
