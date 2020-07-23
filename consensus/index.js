const seedrandom = require('seedrandom');
const ainUtil = require('@ainblockchain/ain-util');
const _ = require('lodash');
const logger = require('../logger');
const { Block } = require('../blockchain/block');
const BlockPool = require('./block-pool');
const DB = require('../db');
const PushId = require('../db/push-id');
const ChainUtil = require('../chain-util');
const { DEBUG, MessageTypes, STAKE, HOSTING_ENV, WriteDbOperations, PredefinedDbPaths }
  = require('../constants');
const { ConsensusMessageTypes, ConsensusConsts, ConsensusStatus, ConsensusDbPaths }
  = require('./constants');
const LOG_PREFIX = 'CONSENSUS';

class Consensus {
  constructor(server, node) {
    this.server = server;
    this.node = node;
    this.status = null;
    this.statusChangedBlockNumber = null;
    this.setter = '';
    this.setStatus(ConsensusStatus.STARTING);
    this.epochInterval = null;
    this.startingTime = 0;
    this.state = {
      // epoch increases by 1 every EPOCH_MS, and at each epoch a new proposer is pseudo-randomly selected.
      epoch: 1,
      proposer: null
    }
  }

  init(lastBlockWithoutProposal) {
    const LOG_SUFFIX = 'init';
    const finalizedNumber = this.node.bc.lastBlockNumber();
    const isFirstNode = finalizedNumber === 0;
    try {
      const currentStake = this.getValidConsensusDeposit(this.node.account.address);
      logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] Current stake: ${currentStake}`);
      if (!currentStake) {
        if (STAKE && STAKE > 0) {
          const stakeTx = this.stake(STAKE);
          if (isFirstNode) {
            // Add the transaction to the pool so it gets included in the block #1
            this.node.tp.addTransaction(stakeTx);
          } else {
            // this.server.executeAndBroadcastTransaction(stakeTx, MessageTypes.TRANSACTION);
            this.node.tp.addTransaction(stakeTx);
            this.server.broadcastTransaction(stakeTx);
          }
        } else {
          if (isFirstNode) {
            logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] First node should stake some AIN and start the consensus protocol`);
            process.exit(1);
          }
          logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] Node doesn't have any stakes. Initialized as a non-validator.`);
        }
      }
      this.blockPool = new BlockPool(this.node, lastBlockWithoutProposal);
      this.setStatus(ConsensusStatus.RUNNING, 'init');
      this.startEpochTransition();
      logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] Initialized to number ${finalizedNumber} and epoch ${this.state.epoch}`);
    } catch (e) {
      logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Init error: ${e}`);
      this.setStatus(ConsensusStatus.STARTING, 'init');
    }
  }

  startEpochTransition() {
    const LOG_SUFFIX = 'startEpochTransition';
    if (this.node.bc.lastBlockNumber() === 0) { // First node here. Create block #1 and kick off the epoch counting
      this.state.proposer = this.node.account.address;
      const proposal = this.createProposal();
      this.startingTime = proposal.proposalBlock.timestamp;
      this.handleConsensusMessage({ value: proposal, type: ConsensusMessageTypes.PROPOSE });
    } else {
      const blockNumberOne = this.node.bc.getBlockByNumber(1);
      if (!blockNumberOne) {
        logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] No block of number 1 exists`);
        process.exit(1);
      }
      this.startingTime = blockNumberOne.timestamp;
    }
    this.state.epoch = Math.ceil((Date.now() - this.startingTime) / ConsensusConsts.EPOCH_MS);
    logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] Epoch initialized to ${this.state.epoch}`);

    this.setEpochTransition();
  }

  setEpochTransition() {
    const LOG_SUFFIX = 'setEpochTransition';
    if (this.epochInterval) {
      clearInterval(this.epochInterval);
    }
    this.epochInterval = setInterval(() => {
      this.tryFinalize();
      let currentTime = Date.now();
      const absEpoch = Math.floor((currentTime - this.startingTime) / ConsensusConsts.EPOCH_MS);
      if (this.state.epoch + 1 < absEpoch) {
        if (DEBUG) {
          logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] Epoch is too low: ${this.state.epoch} / ${absEpoch}`);
        }
      } else if (this.state.epoch + 1 > absEpoch) {
        if (DEBUG) {
          logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] Epoch is too high: ${this.state.epoch} / ${absEpoch}`);
        }
      }
      if (DEBUG) {
        logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] Updating epoch at ${currentTime}: ${this.state.epoch} => ${absEpoch}`);
      }
      // re-adjust and update epoch
      this.state.epoch = absEpoch;
      if (this.state.epoch > 1) {
        this.updateProposer();
        this.tryPropose();
      }
    }, ConsensusConsts.EPOCH_MS);
  }

  stop() {
    logger.info(`[${LOG_PREFIX}] Stop epochInterval.`);
    this.setStatus(ConsensusStatus.STOPPED, 'stop');
    if (this.epochInterval) {
      clearInterval(this.epochInterval);
      this.epochInterval = null;
    }
    // FIXME: reset consensus state or store last state?
  }

  updateProposer() {
    const LOG_SUFFIX = 'updateProposer';
    const lastNotarizedBlock = this.getLastNotarizedBlock();
    if (!lastNotarizedBlock) {
      logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Empty lastNotarizedBlock (${this.state.epoch})`);
    }
    logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] lastNotarizedBlock: ${lastNotarizedBlock.number} / ${lastNotarizedBlock.hash}`);
    const nextNumber = lastNotarizedBlock.number + 1;
    const seedBlock = nextNumber <= ConsensusConsts.MAX_CONSENSUS_STATE_DB ? lastNotarizedBlock
        : this.node.bc.getBlockByNumber(nextNumber - ConsensusConsts.MAX_CONSENSUS_STATE_DB);
    if (!seedBlock) {
      logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Empty seedBlock (${this.state.epoch} / ${lastNotarizedBlock.hash})`);
    }
    let validators;
    if (nextNumber === 1) {
      validators = STAKE > 0 ? { [this.node.account.address] :  STAKE } : {};
    } else {
      validators = lastNotarizedBlock.validators;
    }
    const seed = seedBlock.hash + this.state.epoch;
    this.state.proposer = Consensus.selectProposer(seed, validators);
  }

  // Types of consensus messages:
  //  1. Proposal { value: { proposalBlock, proposalTx }, type = 'PROPOSE' }
  //  2. Vote { value: <voting tx>, type = 'VOTE' }
  handleConsensusMessage(msg) {
    const LOG_SUFFIX = 'handleConsensusMessage';

    if (this.status !== ConsensusStatus.RUNNING) {
      if (DEBUG) {
        logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] Consensus status (${this.status}) is not RUNNING (${ConsensusStatus.RUNNING})`);
      }
      return;
    }
    if (msg.type !== ConsensusMessageTypes.PROPOSE && msg.type !== ConsensusMessageTypes.VOTE) {
      logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Invalid message type: ${msg.type}`);
      return;
    }
    if (!msg.value) {
      logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Invalid message value: ${msg.value}`);
      return;
    }
    logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] Consensus state - finalized number: ${this.node.bc.lastBlockNumber()} / epoch: ${this.state.epoch}\n`);
    if (DEBUG) {
      logger.debug(`Message: ${JSON.stringify(msg.value, null, 2)}`);
    }
    if (msg.type === ConsensusMessageTypes.PROPOSE) {
      const lastNotarizedBlock = this.getLastNotarizedBlock();
        const { proposalBlock, proposalTx } = msg.value;
      if (!proposalBlock || !proposalTx) {
        logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Proposal is missing required fields: ${msg.value}`);
        return;
      }
      if (proposalBlock.number > lastNotarizedBlock.number + 1) {
        logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] Trying to sync. Current last block: ${JSON.stringify(lastNotarizedBlock, null, 2)}`);
        // I might be falling behind. Try to catch up.
        // FIXME(lia): This has a possibility of being exploited by an attacker. The attacker
        // can keep sending messages with higher numbers, making the node's status unsynced, and
        // prevent the node from getting/handling messages properly.
        // this.node.bc.syncedAfterStartup = false;
        
        this.server.requestChainSubsection(this.node.bc.lastBlock());
        return;
      }
      if (Consensus.isValidConsensusTx(proposalTx) && this.checkProposal(proposalBlock, proposalTx)) {
        this.server.broadcastConsensusMessage(msg);
        this.node.db.executeTransaction(proposalTx);
        this.tryVote(proposalBlock);
      }
    } else {
      if (!Consensus.isValidConsensusTx(msg.value) || 
          ChainUtil.transactionFailed(this.server.executeTransaction(msg.value))) {
        if (DEBUG) {
          logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] voting tx execution failed`);
        }
        return;
      }
      this.server.broadcastConsensusMessage(msg);
      this.blockPool.addSeenVote(msg.value, this.state.epoch);
    }
  }

  // proposing for block #N :
  //    1. create a block (with last_votes)
  //    2. create a tx (/consensus/number/N/propose: { block_hash, ... })
  //    3. broadcast tx + block (i.e. call handleConsensusMessage())
  //    4. verify block
  //    5. execute propose tx
  //    6. Nth propose tx should be included in the N+1th block's last_votes
  createProposal() {
    const LOG_SUFFIX = 'createProposal';
    const longestNotarizedChain = this.getLongestNotarizedChain();
    const lastBlock = longestNotarizedChain && longestNotarizedChain.length ?
        longestNotarizedChain[longestNotarizedChain.length - 1] : this.node.bc.lastBlock();
    const blockNumber = lastBlock.number + 1;
    const transactions = this.node.tp.getValidTransactions(longestNotarizedChain);
    const validTransactions = [];
    const prevState = lastBlock.number === this.node.bc.lastBlockNumber() ?
        this.node.bc.backupDb : this.blockPool.hashToState.get(lastBlock.hash);
    const tempState = new DB();
    tempState.dbData = JSON.parse(JSON.stringify(prevState.dbData));
    if (DEBUG) {
      logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] Created a temp state for tx checks`);
    }
    transactions.forEach(tx => {
      if (DEBUG) {
        logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] Checking transaction ${JSON.stringify(tx, null, 2)}`);
      }
      if (!ChainUtil.transactionFailed(tempState.executeTransaction(tx))) {
        logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] transaction result: success!`);
        validTransactions.push(tx);
      } else {
        logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] transaction result: failed..`);
      }
    })
    const lastBlockInfo = this.blockPool.hashToBlockInfo[lastBlock.hash];
    if (DEBUG) {
      logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] lastBlockInfo: ${JSON.stringify(lastBlockInfo, null, 2)}`);
    }
    const lastVotes = blockNumber > 1 && lastBlockInfo.votes ? [...lastBlockInfo.votes] : [];
    if (lastBlockInfo && lastBlockInfo.proposal) {
      lastVotes.unshift(lastBlockInfo.proposal);
    }
    const myAddr = this.node.account.address;
    let validators;
    if (lastBlock.number === 0) {
      if (!STAKE) throw Error('First node must stake some AIN');
      validators = {[myAddr]: STAKE};
    } else {
      validators = this.getValidatorsVotedFor(lastBlock.hash);
    }
    if (!validators || !(Object.keys(validators).length)) throw Error('No validators voted')
    const totalAtStake = Object.values(validators).reduce(function(a, b) { return a + b; }, 0);
    const proposalBlock = Block.createBlock(lastBlock.hash, lastVotes, validTransactions, blockNumber, this.state.epoch, myAddr, validators);

    let proposalTx;
    const txOps = {
      type: WriteDbOperations.SET_VALUE,
      ref: ChainUtil.formatPath([
        ConsensusDbPaths.CONSENSUS,
        ConsensusDbPaths.NUMBER,
        blockNumber,
        ConsensusDbPaths.PROPOSE
      ]),
      value: {
        number: blockNumber,
        epoch: this.state.epoch,
        validators,
        total_at_stake: totalAtStake,
        proposer: myAddr,
        block_hash: proposalBlock.hash,
        last_hash: proposalBlock.last_hash,
        timestamp: proposalBlock.timestamp
      }
    }

    if (blockNumber <= ConsensusConsts.MAX_CONSENSUS_STATE_DB) {
      proposalTx = this.node.createTransaction({ operation: txOps }, false);
    } else {
      proposalTx = this.node.createTransaction({
        operation: {
          type: WriteDbOperations.SET,
          op_list: [
            txOps,
            {
              type: WriteDbOperations.SET_VALUE,
              ref: ChainUtil.formatPath([
                ConsensusDbPaths.CONSENSUS,
                ConsensusDbPaths.NUMBER,
                blockNumber - ConsensusConsts.MAX_CONSENSUS_STATE_DB
              ]),
              value: null
            }
          ]
        }
      }, false);
    }
    return { proposalBlock, proposalTx };
  }

  checkProposal(proposalBlock, proposalTx) {
    const LOG_SUFFIX = 'checkProposal';
    if (this.blockPool.hasSeenBlock(proposalBlock)) {
      logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] Proposal already seen`);
      return false;
    }
    if (proposalTx.address !== proposalBlock.proposer) {
      logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Transaction signer and proposer are different`);
      return false;
    }
    const block_hash = BlockPool.getBlockHashFromTx(proposalTx);
    if (block_hash !== proposalBlock.hash) {
      logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] The block_hash value in proposalTx (${block_hash}) and the actual proposalBlock's hash (${proposalBlock.hash}) don't match`);
      return false;
    }
    if (!Block.validateProposedBlock(proposalBlock)) {
      logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Proposed block didn't pass the basic checks`);
      return false;
    }
    const { proposer, number, epoch, last_hash } = proposalBlock;
    if (number <= this.node.bc.lastBlockNumber()) {
      logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] There already is a finalized block of the number`);
      if (DEBUG) {
        logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] corresponding block info: ${JSON.stringify(this.blockPool.hashToBlockInfo[proposalBlock.hash], null, 2)}`);
      }
      if (!this.blockPool.hasSeenBlock(proposalBlock)) {
        if (DEBUG) {
          logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] Adding the proposal to the blockPool for later use`);
        }
        this.blockPool.addSeenBlock(proposalBlock, proposalTx);
      }
      return false;
    }
    // If I don't have enough votes for prevBlock, see last_votes of proposalBlock if
    // those can notarize the prevBlock (verify, execute and add the missing votes)
    let prevBlockInfo = number === 1 ? this.node.bc.getBlockByNumber(0) : this.blockPool.hashToBlockInfo[last_hash];
    const prevBlock = number > 1 ? prevBlockInfo.block : prevBlockInfo;
    if (DEBUG) {
      logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] prevBlockInfo: ${JSON.stringify(prevBlockInfo, null, 2)}`);
    }
    if (number !== 1 && (!prevBlockInfo || !prevBlockInfo.block)) {
      if (DEBUG) {
        logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] No notarized block at number ${number - 1} with hash ${last_hash}`);
      }
      return;
    }
    if (number !== 1 && !prevBlockInfo.notarized) {
      // Try applying the last_votes of proposalBlock and see if that makes the prev block notarized
      const prevBlockProposal = BlockPool.filterProposal(proposalBlock.last_votes);
      if (!prevBlockProposal) return false;
      if (!prevBlockInfo.proposal) {
        if (number === this.node.bc.lastBlockNumber() + 1) {
          // TODO(lia): do more checks on the prevBlockProposal
          this.blockPool.addSeenBlock(prevBlockInfo.block, prevBlockProposal);
        } else {
          if (DEBUG) {
            logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] Prev block is missing its proposal`);
          }
          return false;
        }
      }
      let prevState = prevBlock.number === this.node.bc.lastBlockNumber() ?
        this.node.bc.backupDb : this.blockPool.hashToState.get(last_hash);
      if (!prevState) {
        prevState = this.getStateSnapshot(prevBlock);
        if (!prevState) {
          logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Previous db state doesn't exist`);
          return false;
        }
      }
      const tempState = new DB();
      tempState.dbData = JSON.parse(JSON.stringify(prevState.dbData));
      proposalBlock.last_votes.forEach(voteTx => {
        if (voteTx.hash === prevBlockProposal.hash) return;
        if (!Consensus.isValidConsensusTx(voteTx) || 
            ChainUtil.transactionFailed(tempState.executeTransaction(voteTx))) {
          logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] voting tx execution for prev block failed`);
          // return;
        }
        this.blockPool.addSeenVote(voteTx);
      });
      prevBlockInfo = this.blockPool.hashToBlockInfo[last_hash];
      if (!prevBlockInfo.notarized) {
        logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Block's last_votes don't correctly notarize its previous block of number ${number - 1} with hash ${last_hash}`);
        return false;
      }
    }
    if (prevBlock.epoch >= epoch) {
      logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Previous block's epoch (${prevBlock.epoch}) is greater than or equal to incoming block's (${epoch})`);
      return false;
    }
    if (!this.blockPool.longestNotarizedChainTips.includes(proposalBlock.last_hash)) {
      logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Block is not extending one of the longest notarized chains (${JSON.stringify(this.blockPool.longestNotarizedChainTips, null, 2)})`);
      return false;
    }
    if (!this.blockPool.addSeenBlock(proposalBlock, proposalTx)) {
      return false;
    }
    let seedBlock = number <= ConsensusConsts.MAX_CONSENSUS_STATE_DB ? prevBlock
        : this.node.bc.getBlockByNumber(number - ConsensusConsts.MAX_CONSENSUS_STATE_DB);
    if (!seedBlock) {
      // FIXME: what to do if finalization doesn't happen within MAX_CONSENSUS_STATE_DB blocks?
      logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] No (${number} - ${ConsensusConsts.MAX_CONSENSUS_STATE_DB})th block to calculate the seed from`);
      return false;
    }
    const seed = seedBlock.hash + epoch;
    let validators;
    if (number === 1) {
      validators = STAKE > 0 ? { [this.node.account.address]:  STAKE } : {};
    } else {
      validators = prevBlock.validators;
    }
    const expectedProposer = Consensus.selectProposer(seed, validators);
    if (expectedProposer !== proposer) {
      logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Proposer is not the expected node (expected: ${expectedProposer} / actual: ${proposer})`);
      return false;
    }
    // TODO(lia): Check last_votes if they indeed voted for the previous block
    // TODO(lia): Check the timestamps and nonces of the last_votes and transactions
    // TODO(lia): Implement state version control
    let prevState = prevBlock.number === this.node.bc.lastBlockNumber() ?
        this.node.bc.backupDb : this.blockPool.hashToState.get(last_hash);
    if (!prevState) {
      prevState = this.getStateSnapshot(prevBlock);
      if (!prevState) {
        logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Previous db state doesn't exist`);
        return false;
      }
    }
    const newState = new DB();
    newState.dbData = JSON.parse(JSON.stringify(prevState.dbData));
    if (!newState.executeTransactionList(proposalBlock.last_votes)) {
      logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Failed to execute last votes`);
      return false;
    }
    if (!newState.executeTransactionList(proposalBlock.transactions)) {
      logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Failed to execute transactions`);
      return false;
    }
    this.blockPool.hashToState.set(proposalBlock.hash, newState);
    logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] proposal verified`);
    return true;
  }

  tryPropose() {
    const LOG_SUFFIX = 'tryPropose';
    if (this.votedForEpoch(this.state.epoch)) {
      logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] Already voted for ${this.blockPool.epochToBlock[this.state.epoch]} at epoch ${this.state.epoch} but trying to propose at the same epoch`);
      return;
    }
    if (ainUtil.areSameAddresses(this.state.proposer, this.node.account.address)) {
      logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] I'm the proposer`);
      this.handleConsensusMessage({ value: this.createProposal(), type: ConsensusMessageTypes.PROPOSE });
    } else {
      logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] Not my turn`);
    }
  }

  tryVote(proposalBlock) {
    const LOG_SUFFIX = 'tryVote';
    logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] Trying to vote for ${proposalBlock.number} / ${proposalBlock.epoch} / ${proposalBlock.hash}`)
    if (this.votedForEpoch(proposalBlock.epoch)) {
      logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] Already voted for epoch ${proposalBlock.epoch}`);
      return;
    }
    if (proposalBlock.epoch < this.state.epoch) {
      logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] Possibly a stale proposal (${proposalBlock.epoch} / ${this.state.epoch})`);
      // FIXME
    }
    this.vote(proposalBlock);
  }

  vote(block) {
    const myAddr = this.node.account.address;
    const myStake = block.number < 3 && block.proposer === myAddr ?
        STAKE : this.getValidConsensusDeposit(myAddr);
    if (myStake === 0) {
      return;
    }
    const voteTx = this.node.createTransaction({
      operation: {
        type: WriteDbOperations.SET_VALUE,
        ref: ChainUtil.formatPath([
          ConsensusDbPaths.CONSENSUS,
          ConsensusDbPaths.NUMBER,
          block.number,
          ConsensusDbPaths.VOTE,
          myAddr
        ]),
        value: {
          [ConsensusDbPaths.BLOCK_HASH]: block.hash,
          [ConsensusDbPaths.STAKE]: myStake
        }
      }
    }, false);
    
    this.handleConsensusMessage({ value: voteTx, type: ConsensusMessageTypes.VOTE });
  }

  // If there's a notarized chain that ends with 3 blocks, which have 3 consecutive epoch numbers,
  // finalize up to second to the last block of that notarized chain.
  tryFinalize() {
    const LOG_SUFFIX = 'tryFinalize';
    let finalizableChain = this.blockPool.getFinalizableChain();
    if (DEBUG) {
      logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] finalizableChain: ${JSON.stringify(finalizableChain, null, 2)}`);
    }
    if (!finalizableChain || !finalizableChain.length) {
      if (DEBUG) {
        logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] No notarized chain with 3 consecutive epochs yet`);
      }
      return;
    }
    // Discard the last block (but save it for a future finalization)
    for (let i = 0; i < finalizableChain.length - 1; i++) {
      const blockToFinalize = finalizableChain[i];
      if (blockToFinalize.number <= this.node.bc.lastBlockNumber()) {
        continue;
      }
      if (this.node.addNewBlock(blockToFinalize)) {
        logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] Finalizing a block of number ${blockToFinalize.number} and hash ${blockToFinalize.hash}`);
      } else {
        logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Failed to finalize a block: ${JSON.stringify(this.state.blockToFinalize, null, 2)}`);
        // FIXME: Stop consensus?
        return;
      }
    }
    this.blockPool.cleanUpAfterFinalization(finalizableChain[finalizableChain.length - 2]);
  }

  catchUp(blockList) {
    const LOG_SUFFIX = 'catchUp';
    if (!blockList || !blockList.length) return;
    let lastVerifiedBlock;
    blockList.forEach(blockInfo => {
      if (DEBUG) {
        logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] Adding notarized chain's block: ${JSON.stringify(blockInfo, null, 2)}`);
      }
      let lastNotarizedBlock = this.getLastNotarizedBlock();
      logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] Current lastNotarizedBlock: ${lastNotarizedBlock.number} / ${lastNotarizedBlock.epoch}`);
      if (!blockInfo.block || !blockInfo.proposal || blockInfo.block.number < lastNotarizedBlock.number) {
        return;
      }
      if (this.checkProposal(blockInfo.block, blockInfo.proposal) || this.blockPool.hasSeenBlock(blockInfo.block)) {
        if (blockInfo.votes) {
          blockInfo.votes.forEach(vote => {
            this.blockPool.addSeenVote(vote);
          });
        }
        if (!lastVerifiedBlock || lastVerifiedBlock.epoch < blockInfo.block.epoch) {
          lastVerifiedBlock = blockInfo.block;
        }
      }
    });

    this.tryFinalize();
    // Try voting for the last block
    if (lastVerifiedBlock) {
      logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] voting for the last verified block: ${lastVerifiedBlock.number} / ${lastVerifiedBlock.epoch}`);
      this.tryVote(lastVerifiedBlock);
    }
  }

  getLongestNotarizedChain() {
    const lastNotarizedBlock = this.getLastNotarizedBlock();
    return this.blockPool.getExtendingChain(lastNotarizedBlock.hash);
  }

  // Returns the last block of the longest notarized chain that was proposed in the most recent epoch
  getLastNotarizedBlock() {
    const LOG_SUFFIX = 'getLastNotarizedBlock';
    let candidate = this.node.bc.lastBlock();
    if (DEBUG) {
      logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] longestNotarizedChainTips: ${JSON.stringify(this.blockPool.longestNotarizedChainTips, null, 2)}`);
    }
    this.blockPool.longestNotarizedChainTips.forEach(chainTip => {
      const block = _.get(this.blockPool.hashToBlockInfo[chainTip], 'block');
      if (!block) return;
      if (block.epoch > candidate.epoch) candidate = block;
    });
    return candidate;
  }

  getCatchUpInfo() {
    let res = [];
    this.blockPool.longestNotarizedChainTips.forEach(chainTip => {
      const chain = this.blockPool.getExtendingChain(chainTip, true);
      res = _.unionWith(res, chain, (a, b) => _.get(a, 'block.hash') === _.get(b, 'block.hash'));
    });
    return res;
  }

  getStateSnapshot(block) {
    const LOG_SUFFIX = 'getStateSnapshot';
    const lastFinalizedHash = this.node.bc.lastBlock().hash;
    const chain = [];
    let currBlock = block;
    let blockHash = currBlock.hash;
    while (currBlock && blockHash !== '' && blockHash !== lastFinalizedHash &&
        !this.blockPool.hashToState.has(blockHash)) {
      chain.unshift(currBlock);
      currBlock = _.get(this.blockPool.hashToBlockInfo[currBlock.last_hash], 'block'); // previous block of currBlock
      blockHash = currBlock ? currBlock.hash : '';
    }
    if (!currBlock || blockHash === '') {
      logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] No currBlock (${currBlock}) or blockHash (${blockHash})`);
      return null;
    }
    const snapshot = new DB();
    if (this.blockPool.hashToState.has(blockHash)) {
      snapshot.dbData = this.blockPool.hashToState.get(blockHash);
    } else if (blockHash === lastFinalizedHash) {
      snapshot.dbData = this.node.bc.backupDb;
    }
    while (chain.length) {
      // apply last_votes and transactions
      const block = chain.shift();
      if (DEBUG) {
        logger.debug(`[[${LOG_PREFIX}:${LOG_SUFFIX}] applying block ${JSON.stringify(block)}`);
      }
      snapshot.executeTransactionList(block.last_votes);
      snapshot.executeTransactionList(block.transactions);
    }
    return snapshot;
  }

  // FIXME: check from the corresponding previous state?
  getValidatorsVotedFor(blockHash) {
    const LOG_SUFFIX = 'getValidatorsVotedFor';
    const blockInfo = this.blockPool.hashToBlockInfo[blockHash];
    if (!blockInfo || !blockInfo.votes || !blockInfo.votes.length) {
      logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] No validators voted`);
      throw Error('No validators voted');
    }
    if (DEBUG) {
      logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] current epoch: ${this.state.epoch}\nblock hash: ${blockHash}\nvotes: ${JSON.stringify(blockInfo.votes, null, 2)}`);
    }
    const validators = {};
    blockInfo.votes.forEach(vote => {
      validators[vote.address] = _.get(vote, 'operation.value.stake');
    });

    return validators;
  }

  getValidConsensusDeposit(address) {
    const deposit = this.node.db.getValue(ChainUtil.formatPath([
      PredefinedDbPaths.DEPOSIT_ACCOUNTS_CONSENSUS,
      address
    ]));

    if (deposit && deposit.value > 0 && deposit.expire_at > Date.now() + ConsensusConsts.DAY_MS) {
      return deposit.value;
    }

    return 0;
  }

  votedForEpoch(epoch) {
    const blockHash = this.blockPool.epochToBlock[epoch];
    if (!blockHash) return false;
    const blockInfo = this.blockPool.hashToBlockInfo[blockHash];
    if (!blockInfo || !blockInfo.votes) return false;
    const myAddr = this.node.account.address;
    return blockInfo.votes.filter(vote => vote.address === myAddr).length > 0;
  }

  stake(amount) {
    const LOG_SUFFIX = 'stake';
    if (!amount || amount <= 0) {
      logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Invalid staking amount received: ${amount}`);
      return null;
    }

    const depositTx = this.node.createTransaction({
      operation: {
        type: WriteDbOperations.SET_VALUE,
        ref: ChainUtil.formatPath([
            PredefinedDbPaths.DEPOSIT_CONSENSUS,
            this.node.account.address,
            PushId.generate(),
            PredefinedDbPaths.DEPOSIT_VALUE
          ]),
        value: amount
      }
    }, false);
    return depositTx;
  }

  isRunning() {
    return this.status === ConsensusStatus.RUNNING;
  }

  setStatus(status, setter = '') {
    const LOG_SUFFIX = 'setStatus';
    logger.info(`[${LOG_PREFIX}:${LOG_SUFFIX}] setting consensus status from ${this.status} to ${status} (setter = ${setter})`);
    this.status = status;
    this.statusChangedBlockNumber = this.node.bc.lastBlockNumber();
    this.setter = setter;
  }

  static selectProposer(seed, validators) {
    const LOG_SUFFIX = 'selectProposer';
    if (DEBUG) {
      logger.debug(`[${LOG_PREFIX}:${LOG_SUFFIX}] seed: ${seed}, validators: ${JSON.stringify(validators)}`);
    }
    const alphabeticallyOrderedValidators = Object.keys(validators).sort();
    const totalAtStake = Object.values(validators).reduce((a, b) => { return a + b; }, 0);
    const randomNumGenerator = seedrandom(seed);
    const targetValue = randomNumGenerator() * totalAtStake;
    let cumulative = 0;
    for (let i = 0; i < alphabeticallyOrderedValidators.length; i++) {
      cumulative += validators[alphabeticallyOrderedValidators[i]];
      if (cumulative > targetValue) {
        logger.info(`Proposer is ${alphabeticallyOrderedValidators[i]}`);
        return alphabeticallyOrderedValidators[i];
      }
    }
    logger.error(`[${LOG_PREFIX}:${LOG_SUFFIX}] Failed to get the proposer.\nvalidators: ${alphabeticallyOrderedValidators}\n` +
        `totalAtStake: ${totalAtStake}\nseed: ${seed}\ntargetValue: ${targetValue}`);
    return null;
  }

  static isValidConsensusTx(tx) {
    if (!tx.operation) return false;
    const consensusTxPrefix = ChainUtil.formatPath([ConsensusDbPaths.CONSENSUS, ConsensusDbPaths.NUMBER]);
    if (tx.operation.type === WriteDbOperations.SET_VALUE) {
      return tx.operation.ref.startsWith(consensusTxPrefix);
    } else if (tx.operation.type === WriteDbOperations.SET) {
      const opList = tx.operation.op_list;
      if (!opList || opList.length !== 2) {
        return false;
      }
      opList.forEach(op => {
        if (!op.ref.startsWith(consensusTxPrefix)) return false;
      })
      return true;
    } else {
      return false;
    }
  }
}

module.exports = Consensus;