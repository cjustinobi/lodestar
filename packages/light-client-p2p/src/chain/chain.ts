import path from "node:path";
import {
  BeaconStateAllForks,
  CachedBeaconStateAllForks,
  computeEpochAtSlot,
  computeStartSlotAtEpoch,
  createCachedBeaconState,
  EffectiveBalanceIncrements,
  getEffectiveBalanceIncrementsZeroInactive,
  isCachedBeaconState,
  Index2PubkeyCache,
  PubkeyIndexMap,
} from "@lodestar/state-transition";
import {IBeaconConfig} from "@lodestar/config";
import {allForks, UintNum64, Root, phase0, Slot, RootHex, Epoch, ValidatorIndex} from "@lodestar/types";
import {CheckpointWithHex, ExecutionStatus, IForkChoice, ProtoBlock} from "@lodestar/fork-choice";
import {ProcessShutdownCallback} from "@lodestar/validator";
import {ILogger, toHex} from "@lodestar/utils";
import {CompositeTypeAny, fromHexString, TreeView, Type} from "@chainsafe/ssz";
import {SLOTS_PER_EPOCH} from "@lodestar/params";

import {IMetrics} from "@lodestar/beacon-node/metrics";
import {IBeaconDb} from "@lodestar/beacon-node";
import {IExecutionBuilder, IExecutionEngine, TransitionConfigurationV1} from "@lodestar/beacon-node/execution";
import {
  CheckpointStateCache,
  IBeaconChain,
  ProposerPreparationData,
  StateContextCache,
} from "@lodestar/beacon-node/chain";
import {LightClientServer} from "@lodestar/beacon-node/chain/lightClient";
import {ReprocessController} from "@lodestar/beacon-node/lib/chain/reprocess";
import {
  AggregatedAttestationPool,
  AttestationPool,
  OpPool,
  SyncCommitteeMessagePool,
  SyncContributionAndProofPool,
} from "@lodestar/beacon-node/chain/opPools";
import {BeaconProposerCache} from "@lodestar/beacon-node/chain/beaconProposerCache";
import {
  SeenAggregators,
  SeenAttesters,
  SeenBlockProposers,
  SeenContributionAndProof,
  SeenSyncCommitteeMessages,
} from "@lodestar/beacon-node/chain/seenCache";
import {SeenAggregatedAttestations} from "@lodestar/beacon-node/chain/seenCache/seenAggregateAndProof";
import {SeenBlockAttesters} from "@lodestar/beacon-node/chain/seenCache/seenBlockAttesters";
import {CheckpointBalancesCache} from "@lodestar/beacon-node/chain/balancesCache";
import {IEth1ForBlockProduction} from "@lodestar/beacon-node/eth1";

import {BlockProcessor, ImportBlockOpts} from "./blocks/index.js";
import {IBeaconClock, LocalClock} from "./clock/index.js";
import {ChainEventEmitter, ChainEvent, HeadEventData} from "./emitter.js";
import {IChainOptions} from "./options.js";
import {IStateRegenerator, QueuedStateRegenerator, RegenCaller} from "./regen/index.js";
import {initializeForkChoice} from "./forkChoice/index.js";
import {computeAnchorCheckpoint} from "./initState.js";
import {IBlsVerifier, BlsSingleThreadVerifier, BlsMultiThreadWorkerPool} from "./bls/index.js";
import {PrepareNextSlotScheduler} from "./prepareNextSlot.js";
import {AssembledBlockType, BlockType} from "./produceBlock/index.js";
import {BlockAttributes, produceBlockBody} from "./produceBlock/produceBlockBody.js";
import {computeNewStateRoot} from "./produceBlock/computeNewStateRoot.js";
import {bytesToData, numToQuantity} from "@lodestar/beacon-node/eth1/provider/utils";
import {ZERO_HASH} from "@lodestar/beacon-node/constants";
import {ensureDir, writeIfNotExist} from "@lodestar/beacon-node/util/file";
import {wrapError} from "@lodestar/beacon-node/util/wrapError";

// TODO DA remove code not needed by light chain and define a proper ILightChain interface
export class LightChain implements IBeaconChain {
  readonly genesisTime: UintNum64;
  readonly genesisValidatorsRoot: Root;
  readonly eth1: IEth1ForBlockProduction;
  readonly executionEngine: IExecutionEngine;
  readonly executionBuilder?: IExecutionBuilder;
  // Expose config for convenience in modularized functions
  readonly config: IBeaconConfig;
  readonly logger: ILogger;

  readonly anchorStateLatestBlockSlot: Slot;

  readonly bls: IBlsVerifier;
  readonly forkChoice: IForkChoice;
  readonly clock: IBeaconClock;
  readonly emitter: ChainEventEmitter;
  readonly stateCache: StateContextCache;
  readonly checkpointStateCache: CheckpointStateCache;
  readonly regen: IStateRegenerator;
  readonly lightClientServer: LightClientServer;
  readonly reprocessController: ReprocessController;

  // Ops pool
  readonly attestationPool = new AttestationPool();
  readonly aggregatedAttestationPool = new AggregatedAttestationPool();
  readonly syncCommitteeMessagePool = new SyncCommitteeMessagePool();
  readonly syncContributionAndProofPool = new SyncContributionAndProofPool();
  readonly opPool = new OpPool();

  // Gossip seen cache
  readonly seenAttesters = new SeenAttesters();
  readonly seenAggregators = new SeenAggregators();
  readonly seenAggregatedAttestations: SeenAggregatedAttestations;
  readonly seenBlockProposers = new SeenBlockProposers();
  readonly seenSyncCommitteeMessages = new SeenSyncCommitteeMessages();
  readonly seenContributionAndProof: SeenContributionAndProof;
  // Seen cache for liveness checks
  readonly seenBlockAttesters = new SeenBlockAttesters();

  // Global state caches
  readonly pubkey2index: PubkeyIndexMap;
  readonly index2pubkey: Index2PubkeyCache;

  readonly beaconProposerCache: BeaconProposerCache;
  readonly checkpointBalancesCache: CheckpointBalancesCache;
  readonly opts: IChainOptions;

  protected readonly blockProcessor: BlockProcessor;
  protected readonly db: IBeaconDb;
  protected readonly metrics: IMetrics | null;
  private abortController = new AbortController();
  private successfulExchangeTransition = false;
  private readonly exchangeTransitionConfigurationEverySlots: number;

  private readonly faultInspectionWindow: number;
  private readonly allowedFaults: number;
  private processShutdownCallback: ProcessShutdownCallback;

  constructor(
    opts: IChainOptions,
    {
      config,
      db,
      logger,
      processShutdownCallback,
      clock,
      metrics,
      anchorState,
      eth1,
      executionEngine,
      executionBuilder,
    }: {
      config: IBeaconConfig;
      db: IBeaconDb;
      logger: ILogger;
      processShutdownCallback: ProcessShutdownCallback;
      /** Used for testing to supply fake clock */
      clock?: IBeaconClock;
      metrics: IMetrics | null;
      anchorState: BeaconStateAllForks;
      eth1: IEth1ForBlockProduction;
      executionEngine: IExecutionEngine;
      executionBuilder?: IExecutionBuilder;
    }
  ) {
    this.opts = opts;
    this.config = config;
    this.db = db;
    this.logger = logger;
    this.processShutdownCallback = processShutdownCallback;
    this.metrics = metrics;
    this.genesisTime = anchorState.genesisTime;
    this.anchorStateLatestBlockSlot = anchorState.latestBlockHeader.slot;
    this.genesisValidatorsRoot = anchorState.genesisValidatorsRoot;
    this.eth1 = eth1;
    this.executionEngine = executionEngine;
    this.executionBuilder = executionBuilder;
    // From https://github.com/ethereum/execution-apis/blob/main/src/engine/specification.md#specification-3
    // > Consensus Layer client software SHOULD poll this endpoint every 60 seconds.
    // Align to a multiple of SECONDS_PER_SLOT for nicer logs
    this.exchangeTransitionConfigurationEverySlots = Math.floor(60 / this.config.SECONDS_PER_SLOT);

    /**
     * Beacon clients select randomized values from the following ranges when initializing
     * the circuit breaker (so at boot time and once for each unique boot).
     *
     * ALLOWED_FAULTS: between 1 and SLOTS_PER_EPOCH // 2
     * FAULT_INSPECTION_WINDOW: between SLOTS_PER_EPOCH and 2 * SLOTS_PER_EPOCH
     *
     */
    this.faultInspectionWindow = Math.max(
      opts.faultInspectionWindow ?? SLOTS_PER_EPOCH + Math.floor(Math.random() * SLOTS_PER_EPOCH),
      SLOTS_PER_EPOCH
    );
    // allowedFaults should be < faultInspectionWindow, limiting them to faultInspectionWindow/2
    this.allowedFaults = Math.min(
      opts.allowedFaults ?? Math.floor(this.faultInspectionWindow / 2),
      Math.floor(this.faultInspectionWindow / 2)
    );

    const signal = this.abortController.signal;
    const emitter = new ChainEventEmitter();
    // by default, verify signatures on both main threads and worker threads
    const bls = opts.blsVerifyAllMainThread
      ? new BlsSingleThreadVerifier({metrics})
      : new BlsMultiThreadWorkerPool(opts, {logger, metrics});

    if (!clock) clock = new LocalClock({config, emitter, genesisTime: this.genesisTime, signal});

    this.seenAggregatedAttestations = new SeenAggregatedAttestations(metrics);
    this.seenContributionAndProof = new SeenContributionAndProof(metrics);

    this.beaconProposerCache = new BeaconProposerCache(opts);
    this.checkpointBalancesCache = new CheckpointBalancesCache();

    // Restore state caches
    // anchorState may already by a CachedBeaconState. If so, don't create the cache again, since deserializing all
    // pubkeys takes ~30 seconds for 350k keys (mainnet 2022Q2).
    // When the BeaconStateCache is created in eth1 genesis builder it may be incorrect. Until we can ensure that
    // it's safe to re-use _ANY_ BeaconStateCache, this option is disabled by default and only used in tests.
    const cachedState =
      isCachedBeaconState(anchorState) && opts.skipCreateStateCacheIfAvailable
        ? anchorState
        : createCachedBeaconState(anchorState, {
            config,
            pubkey2index: new PubkeyIndexMap(),
            index2pubkey: [],
          });

    // Persist single global instance of state caches
    this.pubkey2index = cachedState.epochCtx.pubkey2index;
    this.index2pubkey = cachedState.epochCtx.index2pubkey;

    const stateCache = new StateContextCache({metrics});
    const checkpointStateCache = new CheckpointStateCache({metrics});

    const {checkpoint} = computeAnchorCheckpoint(config, anchorState);
    stateCache.add(cachedState);
    stateCache.setHeadState(cachedState);
    checkpointStateCache.add(checkpoint, cachedState);

    const forkChoice = initializeForkChoice(
      config,
      emitter,
      clock.currentSlot,
      cachedState,
      opts,
      this.justifiedBalancesGetter.bind(this)
    );
    const regen = new QueuedStateRegenerator({
      config,
      forkChoice,
      stateCache,
      checkpointStateCache,
      db,
      metrics,
      emitter,
      signal,
    });

    const lightClientServer = new LightClientServer(opts, {config, db, metrics, emitter, logger});

    this.reprocessController = new ReprocessController(this.metrics);

    this.blockProcessor = new BlockProcessor(this, metrics, opts, signal);

    this.forkChoice = forkChoice;
    this.clock = clock;
    this.regen = regen;
    this.bls = bls;
    this.checkpointStateCache = checkpointStateCache;
    this.stateCache = stateCache;
    this.emitter = emitter;
    this.lightClientServer = lightClientServer;

    // always run PrepareNextSlotScheduler except for fork_choice spec tests
    if (!opts?.disablePrepareNextSlot) {
      new PrepareNextSlotScheduler(this, this.config, metrics, this.logger, signal);
    }

    metrics?.opPool.aggregatedAttestationPoolSize.addCollect(() => this.onScrapeMetrics());

    // Event handlers. emitter is created internally and dropped on close(). Not need to .removeListener()
    emitter.addListener(ChainEvent.clockSlot, this.onClockSlot.bind(this));
    emitter.addListener(ChainEvent.clockEpoch, this.onClockEpoch.bind(this));
    emitter.addListener(ChainEvent.forkChoiceFinalized, this.onForkChoiceFinalized.bind(this));
    emitter.addListener(ChainEvent.forkChoiceJustified, this.onForkChoiceJustified.bind(this));
    emitter.addListener(ChainEvent.head, this.onNewHead.bind(this));
  }

  async close(): Promise<void> {
    this.abortController.abort();
    this.stateCache.clear();
    this.checkpointStateCache.clear();
    await this.bls.close();
  }

  validatorSeenAtEpoch(_index: ValidatorIndex, _epoch: Epoch): boolean {
    // TODO DA Update to a LC specific implementation
    throw new Error("not implemented");
  }

  /** Populate in-memory caches with persisted data. Call at least once on startup */
  async loadFromDisk(): Promise<void> {
    await this.opPool.fromPersisted(this.db);
  }

  /** Persist in-memory data to the DB. Call at least once before stopping the process */
  async persistToDisk(): Promise<void> {
    await this.opPool.toPersisted(this.db);
  }

  getHeadState(): CachedBeaconStateAllForks {
    // TODO DA Update to a LC specific implementation
    throw new Error("not implemented");
  }

  async getHeadStateAtCurrentEpoch(): Promise<CachedBeaconStateAllForks> {
    // TODO DA Update to a LC specific implementation
    throw new Error("not implemented");
  }

  async getCanonicalBlockAtSlot(slot: Slot): Promise<allForks.SignedBeaconBlock | null> {
    // TODO DA Update to a LC specific implementation
    throw new Error("not implemented");
  }

  async produceBlock(blockAttributes: BlockAttributes): Promise<allForks.BeaconBlock> {
    // TODO DA Update to a LC specific implementation
    throw new Error("not implemented");
  }

  async produceBlindedBlock(blockAttributes: BlockAttributes): Promise<allForks.BlindedBeaconBlock> {
    // TODO DA Update to a LC specific implementation
    throw new Error("not implemented");
  }

  async produceBlockWrapper<T extends BlockType>(
    blockType: T,
    {randaoReveal, graffiti, slot}: BlockAttributes
  ): Promise<AssembledBlockType<T>> {
    const head = this.forkChoice.getHead();
    const state = await this.regen.getBlockSlotState(head.blockRoot, slot, RegenCaller.produceBlock);
    const parentBlockRoot = fromHexString(head.blockRoot);
    const proposerIndex = state.epochCtx.getBeaconProposer(slot);
    const proposerPubKey = state.epochCtx.index2pubkey[proposerIndex].toBytes();

    const block = {
      slot,
      proposerIndex,
      parentRoot: parentBlockRoot,
      stateRoot: ZERO_HASH,
      body: await produceBlockBody.call(this, blockType, state, {
        randaoReveal,
        graffiti,
        slot,
        parentSlot: slot - 1,
        parentBlockRoot,
        proposerIndex,
        proposerPubKey,
      }),
    } as AssembledBlockType<T>;

    block.stateRoot = computeNewStateRoot(this.metrics, state, block);

    return block;
  }

  async processBlock(block: allForks.SignedBeaconBlock, opts?: ImportBlockOpts): Promise<void> {
    // TODO DA Update to a LC specific implementation
    throw new Error("not implemented");
  }

  async processChainSegment(blocks: allForks.SignedBeaconBlock[], opts?: ImportBlockOpts): Promise<void> {
    // TODO DA Update to a LC specific implementation
    throw new Error("not implemented");
  }

  getStatus(): phase0.Status {
    // TODO DA Update to a LC specific implementation
    throw new Error("not implemented");
  }

  recomputeForkChoiceHead(): ProtoBlock {
    // TODO DA Update to a LC specific implementation
    throw new Error("not implemented");
  }

  /**
   * Returns Promise that resolves either on block found or once 1 slot passes.
   * Used to handle unknown block root for both unaggregated and aggregated attestations.
   * @returns true if blockFound
   */
  waitForBlockOfAttestation(_slot: Slot, _root: RootHex): Promise<boolean> {
    // TODO DA Update to a LC specific implementation
    throw new Error("not implemented");
  }

  persistInvalidSszValue<T>(_type: Type<T>, _sszObject: T, _suffix?: string): void {
    // TODO DA Update to a LC specific implementation
    throw new Error("not implemented");
  }

  persistInvalidSszView(_view: TreeView<CompositeTypeAny>, _suffix?: string): void {
    // TODO DA Update to a LC specific implementation
    throw new Error("not implemented");
  }

  /**
   * `ForkChoice.onBlock` must never throw for a block that is valid with respect to the network
   * `justifiedBalancesGetter()` must never throw and it should always return a state.
   * @param blockState state that declares justified checkpoint `checkpoint`
   */
  private justifiedBalancesGetter(
    checkpoint: CheckpointWithHex,
    blockState: CachedBeaconStateAllForks
  ): EffectiveBalanceIncrements {
    this.metrics?.balancesCache.requests.inc();

    const effectiveBalances = this.checkpointBalancesCache.get(checkpoint);
    if (effectiveBalances) {
      return effectiveBalances;
    } else {
      // not expected, need metrics
      this.metrics?.balancesCache.misses.inc();
      this.logger.debug("checkpointBalances cache miss", {
        epoch: checkpoint.epoch,
        root: checkpoint.rootHex,
      });

      const {state, stateId, shouldWarn} = this.closestJustifiedBalancesStateToCheckpoint(checkpoint, blockState);
      this.metrics?.balancesCache.closestStateResult.inc({stateId});
      if (shouldWarn) {
        this.logger.warn("currentJustifiedCheckpoint state not avail, using closest state", {
          checkpointEpoch: checkpoint.epoch,
          checkpointRoot: checkpoint.rootHex,
          stateId,
          stateSlot: state.slot,
          stateRoot: toHex(state.hashTreeRoot()),
        });
      }

      return getEffectiveBalanceIncrementsZeroInactive(state);
    }
  }

  /**
   * - Assumptions + invariant this function is based on:
   * - Our cache can only persist X states at once to prevent OOM
   * - Some old states (including to-be justified checkpoint) may / must be dropped from the cache
   * - Thus, there is no guarantee that the state for a justified checkpoint will be available in the cache
   * @param blockState state that declares justified checkpoint `checkpoint`
   */
  private closestJustifiedBalancesStateToCheckpoint(
    checkpoint: CheckpointWithHex,
    blockState: CachedBeaconStateAllForks
  ): {state: CachedBeaconStateAllForks; stateId: string; shouldWarn: boolean} {
    const state = this.checkpointStateCache.get(checkpoint);
    if (state) {
      return {state, stateId: "checkpoint_state", shouldWarn: false};
    }

    // Check if blockState is in the same epoch, not need to iterate the fork-choice then
    if (computeEpochAtSlot(blockState.slot) === checkpoint.epoch) {
      return {state: blockState, stateId: "block_state_same_epoch", shouldWarn: true};
    }

    // Find a state in the same branch of checkpoint at same epoch. Balances should exactly the same
    for (const descendantBlock of this.forkChoice.forwardIterateDescendants(checkpoint.rootHex)) {
      if (computeEpochAtSlot(descendantBlock.slot) === checkpoint.epoch) {
        const descendantBlockState = this.stateCache.get(descendantBlock.stateRoot);
        if (descendantBlockState) {
          return {state: descendantBlockState, stateId: "descendant_state_same_epoch", shouldWarn: true};
        }
      }
    }

    // Check if blockState is in the next epoch, not need to iterate the fork-choice then
    if (computeEpochAtSlot(blockState.slot) === checkpoint.epoch + 1) {
      return {state: blockState, stateId: "block_state_next_epoch", shouldWarn: true};
    }

    // Find a state in the same branch of checkpoint at a latter epoch. Balances are not the same, but should be close
    // Note: must call .forwardIterateDescendants() again since nodes are not sorted
    for (const descendantBlock of this.forkChoice.forwardIterateDescendants(checkpoint.rootHex)) {
      if (computeEpochAtSlot(descendantBlock.slot) > checkpoint.epoch) {
        const descendantBlockState = this.stateCache.get(descendantBlock.stateRoot);
        if (descendantBlockState) {
          return {state: blockState, stateId: "descendant_state_latter_epoch", shouldWarn: true};
        }
      }
    }

    // If there's no state available in the same branch of checkpoint use blockState regardless of its epoch
    return {state: blockState, stateId: "block_state_any_epoch", shouldWarn: true};
  }

  private async persistInvalidSszObject(
    typeName: string,
    bytes: Uint8Array,
    root: Uint8Array,
    suffix?: string
  ): Promise<void> {
    if (!this.opts.persistInvalidSszObjects) {
      return;
    }

    const now = new Date();
    // yyyy-MM-dd
    const dateStr = now.toISOString().split("T")[0];

    // by default store to lodestar_archive of current dir
    const dirpath = path.join(this.opts.persistInvalidSszObjectsDir ?? "invalid_ssz_objects", dateStr);
    const filepath = path.join(dirpath, `${typeName}_${toHex(root)}.ssz`);

    await ensureDir(dirpath);

    // as of Feb 17 2022 there are a lot of duplicate files stored with different date suffixes
    // remove date suffixes in file name, and check duplicate to avoid redundant persistence
    await writeIfNotExist(filepath, bytes);

    this.logger.debug("Persisted invalid ssz object", {id: suffix, filepath});
  }

  private onScrapeMetrics(): void {
    const {attestationCount, attestationDataCount} = this.aggregatedAttestationPool.getAttestationCount();
    this.metrics?.opPool.aggregatedAttestationPoolSize.set(attestationCount);
    this.metrics?.opPool.aggregatedAttestationPoolUniqueData.set(attestationDataCount);
    this.metrics?.opPool.attestationPoolSize.set(this.attestationPool.getAttestationCount());
    this.metrics?.opPool.attesterSlashingPoolSize.set(this.opPool.attesterSlashingsSize);
    this.metrics?.opPool.proposerSlashingPoolSize.set(this.opPool.proposerSlashingsSize);
    this.metrics?.opPool.voluntaryExitPoolSize.set(this.opPool.voluntaryExitsSize);
    this.metrics?.opPool.syncCommitteeMessagePoolSize.set(this.syncCommitteeMessagePool.size);
    this.metrics?.opPool.syncContributionAndProofPoolSize.set(this.syncContributionAndProofPool.size);
  }

  private onClockSlot(slot: Slot): void {
    this.logger.verbose("Clock slot", {slot});

    // CRITICAL UPDATE
    if (this.forkChoice.irrecoverableError) {
      this.processShutdownCallback(this.forkChoice.irrecoverableError);
    }
    this.forkChoice.updateTime(slot);

    this.metrics?.clockSlot.set(slot);

    this.attestationPool.prune(slot);
    this.aggregatedAttestationPool.prune(slot);
    this.syncCommitteeMessagePool.prune(slot);
    this.seenSyncCommitteeMessages.prune(slot);
    this.reprocessController.onSlot(slot);

    if (isFinite(this.config.BELLATRIX_FORK_EPOCH) && slot % this.exchangeTransitionConfigurationEverySlots === 0) {
      this.exchangeTransitionConfiguration().catch((e) => {
        // Should never throw
        this.logger.error("Error on exchangeTransitionConfiguration", {}, e as Error);
      });
    }
  }

  private onClockEpoch(epoch: Epoch): void {
    this.seenAttesters.prune(epoch);
    this.seenAggregators.prune(epoch);
    this.seenAggregatedAttestations.prune(epoch);
    this.seenBlockAttesters.prune(epoch);
    this.beaconProposerCache.prune(epoch);

    // Poll for merge block in the background to speed-up block production. Only if:
    // - after BELLATRIX_FORK_EPOCH
    // - Beacon node synced
    // - head state not isMergeTransitionComplete
    if (this.config.BELLATRIX_FORK_EPOCH - epoch < 1) {
      const head = this.forkChoice.getHead();
      if (epoch - computeEpochAtSlot(head.slot) < 5 && head.executionStatus === ExecutionStatus.PreMerge) {
        this.eth1.startPollingMergeBlock();
      }
    }
  }

  private onNewHead(head: HeadEventData): void {
    const delaySec = this.clock.secFromSlot(head.slot);
    this.logger.verbose("New chain head", {
      headSlot: head.slot,
      headRoot: head.block,
      delaySec,
    });
    this.syncContributionAndProofPool.prune(head.slot);
    this.seenContributionAndProof.prune(head.slot);

    if (this.metrics) {
      this.metrics.headSlot.set(head.slot);
      // Only track "recent" blocks. Otherwise sync can distort this metrics heavily.
      // We want to track recent blocks coming from gossip, unknown block sync, and API.
      if (delaySec < 64 * this.config.SECONDS_PER_SLOT) {
        this.metrics.elapsedTimeTillBecomeHead.observe(delaySec);
      }
    }
  }

  private onForkChoiceJustified(this: LightChain, cp: CheckpointWithHex): void {
    this.logger.verbose("Fork choice justified", {epoch: cp.epoch, root: cp.rootHex});
  }

  private onForkChoiceFinalized(this: LightChain, cp: CheckpointWithHex): void {
    this.logger.verbose("Fork choice finalized", {epoch: cp.epoch, root: cp.rootHex});
    this.seenBlockProposers.prune(computeStartSlotAtEpoch(cp.epoch));

    // TODO: Improve using regen here
    const headState = this.stateCache.get(this.forkChoice.getHead().stateRoot);
    if (headState) {
      this.opPool.pruneAll(headState);
    }
  }

  /**
   * perform heart beat for EL lest it logs warning that CL is not connected
   */
  private async exchangeTransitionConfiguration(): Promise<void> {
    const clConfig: TransitionConfigurationV1 = {
      terminalTotalDifficulty: numToQuantity(this.config.TERMINAL_TOTAL_DIFFICULTY),
      terminalBlockHash: bytesToData(this.config.TERMINAL_BLOCK_HASH),
      /** terminalBlockNumber has to be set to zero for now as per specs */
      terminalBlockNumber: numToQuantity(0),
    };

    const elConfigRes = await wrapError(this.executionEngine.exchangeTransitionConfigurationV1(clConfig));

    if (elConfigRes.err) {
      // Note: Will throw an error if:
      // - EL endpoint is offline, unreachable, port not exposed, etc
      // - JWT secret is not properly configured
      // - If there is a missmatch in configuration with Geth, see https://github.com/ethereum/go-ethereum/blob/0016eb7eeeb42568c8c20d0cb560ddfc9a938fad/eth/catalyst/api.go#L301
      this.successfulExchangeTransition = false;

      this.logger.warn("Could not validate transition configuration with execution client", {}, elConfigRes.err);
    } else {
      // Note: This code is useless when connected to Geth. If there's a configuration mismatch Geth returns an
      // error instead of its own transition configuration, so we can't do this comparision.
      const elConfig = elConfigRes.result;
      const keysToCheck: (keyof TransitionConfigurationV1)[] = ["terminalTotalDifficulty", "terminalBlockHash"];
      const errors: string[] = [];

      for (const key of keysToCheck) {
        if (elConfig[key] !== clConfig[key]) {
          errors.push(`different ${key} (cl ${clConfig[key]} el ${elConfig[key]})`);
        }
      }

      if (errors.length > 0) {
        this.logger.warn(`Transition configuration mismatch: ${errors.join(", ")}`);
      } else {
        // Only log once per successful call
        if (!this.successfulExchangeTransition) {
          this.logger.info("Validated transition configuration with execution client", clConfig);
          this.successfulExchangeTransition = true;
        }
      }
    }
  }

  async updateBeaconProposerData(_epoch: Epoch, _proposers: ProposerPreparationData[]): Promise<void> {
    // TODO DA Update to a LC specific implementation
    throw new Error("not implemented");
  }

  updateBuilderStatus(_clockSlot: Slot): void {
    // TODO DA Update to a LC specific implementation
    throw new Error("not implemented");
  }
}
