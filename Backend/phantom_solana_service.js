import { Connection } from '@solana/web3.js';
import {
  validateAddress,
  getExistingTokenAccount,
  ensureAtaForOwner
} from './phantom_solana_accounts.js';
import {
  appendReference,
  calculateFee,
  createTransaction,
  findTransactionByReference,
  generatePaymentReference,
  precheckPayment,
  simulateTransaction,
  toBaseUnits,
  verifyTransaction
} from './phantom_solana_builder.js';

const config = {
  solana: {
    rpcUrl: process.env.SOLANA_RPC_URL
  }
};

class SolanaService {
  constructor() {
    this.connection = new Connection(config.solana.rpcUrl, 'confirmed');
  }

  calculateFee(amount) {
    return calculateFee(amount);
  }

  toBaseUnits(value, decimals) {
    return toBaseUnits(value, decimals);
  }

  async getExistingTokenAccount(owner, mint) {
    return getExistingTokenAccount(this, owner, mint);
  }

  async ensureAtaForOwner(ownerAddress, token = 'USDC') {
    return ensureAtaForOwner(this, ownerAddress, token);
  }

  generatePaymentReference() {
    return generatePaymentReference();
  }

  appendReference(transaction, reference) {
    return appendReference(transaction, reference);
  }

  async createTransaction(payerAddress, merchantAddress, merchantAmount, feeAmount, token = 'USDC', reference = null) {
    return createTransaction(this, payerAddress, merchantAddress, merchantAmount, feeAmount, token, reference);
  }

  async precheckPayment(payerAddress, merchantAddress, merchantAmount, feeAmount, token = 'USDC') {
    return precheckPayment(this, payerAddress, merchantAddress, merchantAmount, feeAmount, token);
  }

  async simulateTransaction(transaction) {
    return simulateTransaction(this, transaction);
  }

  validateAddress(address) {
    return validateAddress(this, address);
  }

  async verifyTransaction(txSignature, expectedRecipient, expectedAmount, options = {}) {
    return verifyTransaction(this, txSignature, expectedRecipient, expectedAmount, options);
  }

  async findTransactionByReference(reference, options = {}) {
    return findTransactionByReference(this, reference, options);
  }
}

export default new SolanaService();
