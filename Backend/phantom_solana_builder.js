import {
  Connection,
  PublicKey,
  Keypair,
  Transaction
} from '@solana/web3.js';
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID
} from '@solana/spl-token';

const RPC_URL = process.env.SOLANA_RPC_URL;
const USDC_MINT = process.env.USDC_MINT;
const USDC_DECIMALS = Number(process.env.USDC_DECIMALS || 6);
const FEE_WALLET = process.env.CRYPTONOW_FEE_WALLET;

class PhantomSolanaBuilder {
  constructor() {
    this.connection = new Connection(RPC_URL, 'confirmed');
  }

  validateAddress(address) {
    try { new PublicKey(address); return true; } catch { return false; }
  }

  calculateFee(amount) {
    const safe = Number(amount);
    if (!Number.isFinite(safe) || safe <= 0) return 0.01;
    return Math.max(0.01, Math.floor(safe) * 0.01);
  }

  generatePaymentReference() {
    return Keypair.generate().publicKey.toBase58();
  }

  async getExistingUsdcAta(ownerAddress) {
    const owner = new PublicKey(ownerAddress);
    const mint = new PublicKey(USDC_MINT);
    const ata = await getAssociatedTokenAddress(mint, owner);
    const info = await this.connection.getAccountInfo(ata);
    return info ? ata : null;
  }

  async precheckUsdcPayment({ payerAddress, merchantAddress, merchantAmount, feeAmount }) {
    try {
      const payerAta = await this.getExistingUsdcAta(payerAddress);
      const merchantAta = await this.getExistingUsdcAta(merchantAddress);
      const feeAta = await this.getExistingUsdcAta(FEE_WALLET);
      if (!payerAta) return { ok: false, error: 'Payer token account is missing', errorKey: 'insufficient_funds' };
      if (!merchantAta || !feeAta) return { ok: false, error: 'Required recipient token account is missing', errorKey: 'transaction_failed_retry' };

      const payerBal = await this.connection.getTokenAccountBalance(payerAta);
      const requiredUnits =
        BigInt(Math.floor(Number(merchantAmount) * 10 ** USDC_DECIMALS)) +
        BigInt(Math.floor(Number(feeAmount) * 10 ** USDC_DECIMALS));
      const payerUnits = BigInt(payerBal.value.amount || '0');

      if (payerUnits < requiredUnits) {
        return { ok: false, error: 'Insufficient token balance', errorKey: 'insufficient_funds' };
      }

      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || 'Precheck failed', errorKey: 'transaction_failed_retry' };
    }
  }

  async createUsdcSplitTransaction({ payerAddress, merchantAddress, merchantAmount, feeAmount, reference }) {
    const payer = new PublicKey(payerAddress);
    const merchant = new PublicKey(merchantAddress);
    const feeWallet = new PublicKey(FEE_WALLET);
    const mint = new PublicKey(USDC_MINT);

    const payerAta = await this.getExistingUsdcAta(payerAddress);
    const merchantAta = await this.getExistingUsdcAta(merchantAddress);
    const feeAta = await this.getExistingUsdcAta(FEE_WALLET);

    if (!payerAta || !merchantAta || !feeAta) throw new Error('USDC token account missing');

    const merchantUnits = Math.floor(Number(merchantAmount) * 10 ** USDC_DECIMALS);
    const feeUnits = Math.floor(Number(feeAmount) * 10 ** USDC_DECIMALS);

    const tx = new Transaction().add(
      createTransferCheckedInstruction(payerAta, mint, merchantAta, payer, merchantUnits, USDC_DECIMALS, [], TOKEN_PROGRAM_ID),
      createTransferCheckedInstruction(payerAta, mint, feeAta, payer, feeUnits, USDC_DECIMALS, [], TOKEN_PROGRAM_ID)
    );

    if (reference) {
      const ref = new PublicKey(reference);
      for (const ix of tx.instructions) {
        if (!ix.keys.some(k => k.pubkey.equals(ref))) {
          ix.keys.push({ pubkey: ref, isSigner: false, isWritable: false });
        }
      }
    }

    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer;

    return tx;
  }

  async simulateTransaction(transaction) {
    try {
      if (!transaction?.feePayer) return { ok: false, error: 'Missing fee payer' };
      if (!transaction.signatures?.length) {
        transaction.signatures = [{ publicKey: transaction.feePayer, signature: null }];
      }

      const result = await this.connection.simulateTransaction(transaction, undefined, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'processed'
      });

      if (result.value?.err) return { ok: false, error: result.value.err, logs: result.value.logs || [] };
      return { ok: true, logs: result.value?.logs || [] };
    } catch (e) {
      return { ok: false, error: e?.message || 'Simulation failed', logs: [] };
    }
  }
}

export const solanaBuilder = new PhantomSolanaBuilder();
