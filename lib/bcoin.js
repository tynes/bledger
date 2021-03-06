/*!
 * bcoin.js - Ledger communication with bcoin primitives
 * Copyright (c) 2018, The Bcoin Developers (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const assert = require('assert');
const util = require('./utils/util');

const {Lock} = require('bmutex');

const Network = require('bcoin/lib/protocol/network');
const MTX = require('bcoin/lib/primitives/mtx');
const HDPublicKey = require('bcoin/lib/hd/public');
const Script = require('bcoin/lib/script').Script;
const secp256k1 = require('bcrypto').secp256k1;

const {Device} = require('./devices/device');
const LedgerBTC = require('./ledger');

/**
 * Ledger BTC App with bcoin primitives
 */

class LedgerBcoin {
  /**
   * Create ledger bcoin app
   * @constructor
   * @param {Object} options
   * @param {String} options.path
   * @param {Device} options.device
   */

  constructor(options) {
    this.device = null;
    this.ledger = null;
    this.network = Network.primary;

    this.signingTX = false;
    this.txlock = new Lock(false);

    if (options)
      this.set(options);
  }

  /**
   * Set options
   * @param {Object} options
   */

  set(options) {
    assert(options);

    if (options.network)
      this.network = Network.get(options.network);

    if (options.device != null) {
      assert(options.device instanceof Device);
      this.device = options.device;
      this.device.set({
        scrambleKey: 'BTC'
      });

      this.ledger = new LedgerBTC(options.device);
    }

    return this;
  }

  /**
   * Get public key
   * @async
   * @param {(Number[]|String)} - Full derivation path
   * @param {apdu.addressFlags} [addressFlags=0x00]
   * @returns {bcoin.HDPublicKey}
   * @throws {LedgerError}
   */

  async getPublicKey(path, addressFlags = 0) {
    assert(this.device);
    assert(path);

    if (typeof path === 'string')
      path = util.parsePath(path, true);

    assert(Array.isArray(path), 'Path must be string or array');

    const indexes = path;
    const data = await this.ledger.getPublicKey(path, addressFlags);
    const rawPubkey = data.publicKey;
    const compressedPubkey = secp256k1.publicKeyConvert(rawPubkey, true);

    return new HDPublicKey({
      depth: indexes.length,
      childIndex: indexes[indexes.length - 1],
      parentFingerPrint: 0,
      chainCode: data.chainCode,
      publicKey: compressedPubkey,
      network: this.network
    });
  }

  /**
   * Sign transaction
   * Ledger should finish signing one transaction
   * in order to sign another
   * @async
   * @param {bcoin.MTX} tx - mutable transaction
   * @param {LedgerTXInput[]} ledgerInputs
   * @returns {MTX} - signed mutable transaction
   * @throws {LedgerError}
   * @throws {AssertionError}
   */

  async signTransaction(tx, ledgerInputs) {
    const unlock = await this.txlock.lock();

    try {
      return await this._signTransaction(tx, ledgerInputs);
    } finally {
      unlock();
    }
  }

  /**
   * Sign transaction
   * @async
   * @param {bcoin.MTX} tx - mutable transaction
   * @param {LedgerTXInput[]} ledgerInputs
   * @returns {MTX} - signed mutable transaction
   * @throws {LedgerError}
   * @throws {AssertionError}
   */

  async _signTransaction(tx, ledgerInputs) {
    assert(MTX.isMTX(tx), 'Cannot use non-MTX tx for signing');

    this.signingTX = true;

    const trustedInputs = Object.create(null);
    const txIndexByKey = Object.create(null);

    let hasWitness = false;

    // Update public keys for keyrings
    for (const li of ledgerInputs) {
      if (!li.publicKey) {
        const hd = await this.getPublicKey(li.path);
        li.publicKey = hd.publicKey;
      }
    }

    // Collect trusted inputs
    for (const li of ledgerInputs) {
      if (li.witness) {
        hasWitness = true;
        continue;
      }

      if (li.redeem)
        continue;

      const pokey = li.toKey();
      const trustedInput = await this.ledger.getTrustedInput(li.tx, li.index);

      trustedInputs[pokey] = trustedInput;
    }

    // Find indexes in transaction
    for (const [i, input] of tx.inputs.entries()) {
      const pokey = input.prevout.toKey();

      txIndexByKey[pokey] = i;
    }

    let newtx = true;

    if (hasWitness) {
      // load transaction with all inputs for caching hashing data
      await this.ledger.hashTransactionStart(tx, {}, true, true);
      await this.ledger.hashOutputFinalize(tx);

      newtx = false;
    }

    for (const li of ledgerInputs) {
      const pokey = li.toKey();
      const index = txIndexByKey[pokey];

      await this.signInput(tx, li, trustedInputs, index, newtx);
      newtx = false;
    }

    this.signingTX = false;

    return tx;
  }

  /**
   * Sign input
   * @param {bcoin.MTX} tx - mutable transaction
   * @param {LedgerTXInput} ledgerInput
   * @param {Buffer[]} trustedInputs
   * @param {Number} index - Input index in new tx
   * @param {Boolean} isNew - is it new transaction
   * @returns {bcoin.MTX}
   * @see {bcoin.MTX#signInput}
   * @see {bcoin.MTX#scriptInput}
   */

  async signInput(tx, ledgerInput, trustedInputs, index, isNew = false) {
    const input = tx.inputs[index];
    const inputKey = ledgerInput.toKey();
    const ring = ledgerInput.getRing(this.network);
    const coin = ledgerInput.getCoin();

    const templated = tx.scriptInput(index, coin, ring);

    if (!templated)
      throw new Error('Could not template input');

    // Get the previous output's script
    let prev = coin.script;
    let vector = input.script;
    let redeem = false;
    let witness = false;

    // Grab regular p2sh redeem script.
    if (prev.isScripthash()) {
      prev = input.script.getRedeem();

      if (!prev)
        throw new Error('Redeem Script not found');
      redeem = true;
    }

    // If the output script is a witness program,
    // we have to switch the vector to the witness
    // and potentially alter the length. Note that
    // witnesses are stack items, so the `dummy`
    // _has_ to be an empty buffer (what OP_0
    // pushes onto the stack).
    if (prev.isWitnessScripthash()) {
      prev = input.witness.getRedeem();

      if (!prev)
        throw new Error('Input has not been templated.');
      vector = input.witness;
      redeem = true;
      witness = true;
    } else {
      const wpkh = prev.getWitnessPubkeyhash();
      if (wpkh) {
        prev = Script.fromPubkeyhash(wpkh);
        vector = input.witness;
        redeem = false;
        witness = true;
      }
    }

    if (!witness) {
      await this.ledger.hashTransactionStartNullify(
        tx,
        inputKey,
        prev,
        trustedInputs,
        isNew,
        witness
      );

      await this.ledger.hashOutputFinalize(tx);
    } else {
      await this.ledger.hashTransactionStartSegwit(tx, inputKey, prev);
    }

    const sig = await this.ledger.hashSign(
      tx,
      ledgerInput.path,
      ledgerInput.type
    );

    if (redeem) {
      const stack = vector.toStack();
      const redeem = stack.pop();

      const result = tx.signVector(prev, stack, sig, ring);

      if (!result)
        return false;

      result.push(redeem);

      vector.fromStack(result);

      return true;
    }

    const stack = vector.toStack();
    const result = tx.signVector(prev, stack, sig, ring);

    if (!result)
      return false;

    vector.fromStack(result);

    return true;
  }
}

LedgerBcoin.addressFlags = LedgerBTC.addressFlags;

module.exports = LedgerBcoin;
