import {toHexString} from "@chainsafe/ssz";
import {
  BLSPubkey,
  Slot,
  BLSSignature,
  allForks,
  isBlindedSignedBeaconBlock,
  ProducedBlockSource,
  deneb,
  isBlockContents,
} from "@lodestar/types";
import {ChainForkConfig} from "@lodestar/config";
import {ForkPreBlobs, ForkBlobs, ForkSeq, ForkExecution} from "@lodestar/params";
import {extendError, prettyBytes} from "@lodestar/utils";
import {Api, ApiError, routes} from "@lodestar/api";
import {interopSecretKey} from "@lodestar/state-transition";
import {IClock, LoggerVc} from "../util/index.js";
import {PubkeyHex} from "../types.js";
import {Metrics} from "../metrics.js";
import {formatBigDecimal} from "../util/format.js";
import {ValidatorStore} from "./validatorStore.js";
import {BlockDutiesService, GENESIS_SLOT} from "./blockDuties.js";

const ETH_TO_WEI = BigInt("1000000000000000000");
// display upto 5 decimal places
const MAX_DECIMAL_FACTOR = BigInt("100000");

// The following combination of blocks and blobs can be produced
//  i) a full block pre deneb
//  ii) a full block and full blobs post deneb
//  iii) a blinded block post bellatrix
type FullOrBlindedBlockWithContents =
  | {
      version: ForkPreBlobs;
      block: allForks.BeaconBlock;
      contents: null;
      executionPayloadBlinded: false;
      executionPayloadSource: ProducedBlockSource.engine;
    }
  | {
      version: ForkBlobs;
      block: allForks.BeaconBlock;
      contents: {
        kzgProofs: deneb.KZGProofs;
        blobs: deneb.Blobs;
      };
      executionPayloadBlinded: false;
      executionPayloadSource: ProducedBlockSource.engine;
    }
  | {
      version: ForkExecution;
      block: allForks.BlindedBeaconBlock;
      contents: null;
      executionPayloadBlinded: true;
      executionPayloadSource: ProducedBlockSource;
    };

type DebugLogCtx = {debugLogCtx: Record<string, string | boolean | undefined>};
type BlockProposalOpts = {
  useProduceBlockV3: boolean;
  broadcastValidation: routes.beacon.BroadcastValidation;
  blindedLocal: boolean;
};
/**
 * Service that sets up and handles validator block proposal duties.
 */
export class BlockProposingService {
  private readonly dutiesService: BlockDutiesService;

  constructor(
    private readonly config: ChainForkConfig,
    private readonly logger: LoggerVc,
    private readonly api: Api,
    private readonly clock: IClock,
    private readonly validatorStore: ValidatorStore,
    private readonly metrics: Metrics | null,
    private readonly opts: BlockProposalOpts
  ) {
    this.dutiesService = new BlockDutiesService(
      config,
      logger,
      api,
      clock,
      validatorStore,
      metrics,
      this.notifyBlockProductionFn
    );
    clock.runEverySlot(this.runTest);
  }

  removeDutiesForKey(pubkey: PubkeyHex): void {
    this.dutiesService.removeDutiesForKey(pubkey);
  }

  /**
   * `BlockDutiesService` must call this fn to trigger block creation
   * This function may run more than once at a time, rationale in `BlockDutiesService.pollBeaconProposers`
   */
  private notifyBlockProductionFn = (slot: Slot, proposers: BLSPubkey[]): void => {
    if (slot <= GENESIS_SLOT) {
      this.logger.debug("Not producing block before or at genesis slot");
      return;
    }

    if (proposers.length > 1) {
      this.logger.warn("Multiple block proposers", {slot, count: proposers.length});
    }

    Promise.all(proposers.map((pubkey) => this.createAndPublishBlock(pubkey, slot))).catch((e: Error) => {
      this.logger.error("Error on block duties", {slot}, e);
    });
  };

  private runTest = async (slot: Slot): Promise<void> => {
    try {
      const secretKey = interopSecretKey(0);
      const pubkey = secretKey.toPublicKey().toBytes();
      const pubkeyHex = toHexString(pubkey);
      const randaoReveal = await this.validatorStore.signRandao(pubkey, slot);
      const graffiti = this.validatorStore.getGraffiti(pubkeyHex);
      const blindedLocal = true;
      const blockContents = await this.produceBlockWrapper(this.config, slot, randaoReveal, graffiti, {blindedLocal});
      const produceTime = this.clock.secFromSlot(slot);
      const signedBlock = await this.validatorStore.signBlock(pubkey, blockContents.block, slot, this.logger);
      await this.publishBlockWrapper(signedBlock, null, {
        broadcastValidation: this.opts.broadcastValidation,
      }).catch((e: Error) => {
        this.metrics?.blockProposingErrors.inc({error: "publish"});
        throw extendError(e, "Failed to publish block");
      });
      const publishTime = this.clock.secFromSlot(slot);
      this.logger.info("@@@ Test block produce and publish", {
        slot,
        produceTime,
        publishTime,
        totalTimeSec: publishTime - produceTime,
      });
    } catch (e) {
      this.logger.error("error producing block", {slot}, e as Error);
    }
  };

  /** Produce a block at the given slot for pubkey */
  private async createAndPublishBlock(pubkey: BLSPubkey, slot: Slot): Promise<void> {
    const pubkeyHex = toHexString(pubkey);
    const logCtx = {slot, validator: prettyBytes(pubkeyHex)};

    // Wrap with try catch here to re-use `logCtx`
    try {
      const randaoReveal = await this.validatorStore.signRandao(pubkey, slot);
      const graffiti = this.validatorStore.getGraffiti(pubkeyHex);

      const debugLogCtx = {...logCtx, validator: pubkeyHex};

      const strictFeeRecipientCheck = this.validatorStore.strictFeeRecipientCheck(pubkeyHex);
      const builderSelection = this.validatorStore.getBuilderSelection(pubkeyHex);
      const feeRecipient = this.validatorStore.getFeeRecipient(pubkeyHex);
      const blindedLocal = this.opts.blindedLocal;

      this.logger.debug("Producing block", {
        ...debugLogCtx,
        builderSelection,
        feeRecipient,
        strictFeeRecipientCheck,
        useProduceBlockV3: this.opts.useProduceBlockV3,
        blindedLocal,
      });
      this.metrics?.proposerStepCallProduceBlock.observe(this.clock.secFromSlot(slot));

      const produceBlockFn = this.opts.useProduceBlockV3 ? this.produceBlockWrapper : this.produceBlockV2Wrapper;
      const blockContents = await produceBlockFn(this.config, slot, randaoReveal, graffiti, {
        feeRecipient,
        strictFeeRecipientCheck,
        builderSelection,
        blindedLocal,
      }).catch((e: Error) => {
        this.metrics?.blockProposingErrors.inc({error: "produce"});
        throw extendError(e, "Failed to produce block");
      });

      this.logger.debug("Produced block", {...debugLogCtx, ...blockContents.debugLogCtx});
      this.metrics?.blocksProduced.inc();

      const signedBlock = await this.validatorStore.signBlock(pubkey, blockContents.block, slot);
      await this.publishBlockWrapper(signedBlock, blockContents.contents, this.opts).catch((e: Error) => {
        this.metrics?.blockProposingErrors.inc({error: "publish"});
        throw extendError(e, "Failed to publish block");
      });
      this.metrics?.proposerStepCallPublishBlock.observe(this.clock.secFromSlot(slot));
      this.metrics?.blocksPublished.inc();
      this.logger.info("Published block", {...logCtx, graffiti, ...blockContents.debugLogCtx});
    } catch (e) {
      this.logger.error("Error proposing block", logCtx, e as Error);
    }
  }

  private publishBlockWrapper = async (
    signedBlock: allForks.FullOrBlindedSignedBeaconBlock,
    contents: {kzgProofs: deneb.KZGProofs; blobs: deneb.Blobs} | null,
    opts: {broadcastValidation?: routes.beacon.BroadcastValidation} = {}
  ): Promise<void> => {
    if (isBlindedSignedBeaconBlock(signedBlock)) {
      if (contents !== null) {
        this.logger.warn(
          "Ignoring contents while publishing blinded block - publishing beacon should assemble it from its local cache or builder"
        );
      }
      ApiError.assert(await this.api.beacon.publishBlindedBlockV2(signedBlock, opts));
    } else {
      if (contents === null) {
        ApiError.assert(await this.api.beacon.publishBlockV2(signedBlock, opts));
      } else {
        ApiError.assert(await this.api.beacon.publishBlockV2({...contents, signedBlock}, opts));
      }
    }
  };

  private produceBlockWrapper = async (
    _config: ChainForkConfig,
    slot: Slot,
    randaoReveal: BLSSignature,
    graffiti: string,
    {feeRecipient, strictFeeRecipientCheck, builderSelection, blindedLocal}: routes.validator.ExtraProduceBlockOps
  ): Promise<FullOrBlindedBlockWithContents & DebugLogCtx> => {
    const res = await this.api.validator.produceBlockV3(slot, randaoReveal, graffiti, false, {
      feeRecipient,
      builderSelection,
      strictFeeRecipientCheck,
      blindedLocal
    });
    ApiError.assert(res, "Failed to produce block: validator.produceBlockV2");
    const {response} = res;

    const debugLogCtx = {
      source: response.executionPayloadBlinded ? ProducedBlockSource.builder : ProducedBlockSource.engine,
      // winston logger doesn't like bigint
      executionPayloadValue: `${formatBigDecimal(response.executionPayloadValue, ETH_TO_WEI, MAX_DECIMAL_FACTOR)} ETH`,
      consensusBlockValue: `${formatBigDecimal(response.consensusBlockValue, ETH_TO_WEI, MAX_DECIMAL_FACTOR)} ETH`,
      totalBlockValue: `${formatBigDecimal(
        response.executionPayloadValue + response.consensusBlockValue,
        ETH_TO_WEI,
        MAX_DECIMAL_FACTOR
      )} ETH`,
      // TODO PR: should be used in api call instead of adding in log
      strictFeeRecipientCheck,
      blindedLocal,
      builderSelection,
      api: "produceBlockV3",
    };

    return parseProduceBlockResponse(response, debugLogCtx);
  };

  /** a wrapper function used for backward compatibility with the clients who don't have v3 implemented yet */
  private produceBlockV2Wrapper = async (
    config: ChainForkConfig,
    slot: Slot,
    randaoReveal: BLSSignature,
    graffiti: string,
    {builderSelection}: routes.validator.ExtraProduceBlockOps
  ): Promise<FullOrBlindedBlockWithContents & DebugLogCtx> => {
    // other clients have always implemented builder vs execution race in produce blinded block
    // so if builderSelection is executiononly then only we call produceBlockV2 else produceBlockV3 always
    const debugLogCtx = {builderSelection};
    const fork = config.getForkName(slot);

    if (ForkSeq[fork] < ForkSeq.bellatrix || builderSelection === routes.validator.BuilderSelection.ExecutionOnly) {
      Object.assign(debugLogCtx, {api: "produceBlockV2"});
      const res = await this.api.validator.produceBlockV2(slot, randaoReveal, graffiti);
      ApiError.assert(res, "Failed to produce block: validator.produceBlockV2");
      const {response} = res;
      const executionPayloadSource = ProducedBlockSource.engine;

      return parseProduceBlockResponse(
        {executionPayloadBlinded: false, executionPayloadSource, ...response},
        debugLogCtx
      );
    } else {
      Object.assign(debugLogCtx, {api: "produceBlindedBlock"});
      const res = await this.api.validator.produceBlindedBlock(slot, randaoReveal, graffiti);
      ApiError.assert(res, "Failed to produce block: validator.produceBlockV2");
      const {response} = res;
      const executionPayloadSource = ProducedBlockSource.builder;

      return parseProduceBlockResponse(
        {executionPayloadBlinded: true, executionPayloadSource, ...response},
        debugLogCtx
      );
    }
  };
}

function parseProduceBlockResponse(
  response: routes.validator.ProduceFullOrBlindedBlockOrContentsRes,
  debugLogCtx: Record<string, string | boolean | undefined>
): FullOrBlindedBlockWithContents & DebugLogCtx {
  if (response.executionPayloadBlinded) {
    return {
      block: response.data,
      contents: null,
      version: response.version,
      executionPayloadBlinded: true,
      executionPayloadSource: response.executionPayloadSource,
      debugLogCtx,
    } as FullOrBlindedBlockWithContents & DebugLogCtx;
  } else {
    if (isBlockContents(response.data)) {
      return {
        block: response.data.block,
        contents: {blobs: response.data.blobs, kzgProofs: response.data.kzgProofs},
        version: response.version,
        executionPayloadBlinded: false,
        executionPayloadSource: response.executionPayloadSource,
        debugLogCtx,
      } as FullOrBlindedBlockWithContents & DebugLogCtx;
    } else {
      return {
        block: response.data,
        contents: null,
        version: response.version,
        executionPayloadBlinded: false,
        executionPayloadSource: response.executionPayloadSource,
        debugLogCtx,
      } as FullOrBlindedBlockWithContents & DebugLogCtx;
    }
  }
}
