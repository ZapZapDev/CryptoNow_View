import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import solanaService from './phantom_solana_service.js';
import { isUuid } from '../utils/validation.js';

const config = {
  cryptonow: {
    feeWallet: process.env.CRYPTONOW_FEE_WALLET
  }
};

const txCache = new Map();
const TX_CACHE_TTL_MS = 60 * 1000;

export async function createMerchantTransaction(req, res) {
  try {
    const { sessionKey } = req.params;
    const { account } = req.body;

    if (!account || !solanaService.validateAddress(account)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    if (!isUuid(sessionKey)) {
      return res.status(400).json({ error: 'Invalid session key' });
    }

    const session = await Session.findOne({ where: { session_key: sessionKey } });
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    let payment = null;
    if (session.payment_id) {
      payment = await Payment.findByPk(session.payment_id);
    }
    if (!payment) {
      payment = await Payment.findOne({
        where: { session_id: session.id },
        order: [['created_at', 'DESC']]
      });
    }
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    if (payment.transaction_status === 'paid' || payment.txid || session.ui_state === 'completed') {
      return res.status(409).json({ error: 'Payment already completed' });
    }

    const displayAmountRaw = payment.total_amount ?? payment.amount;
    const displayAmount = Number.isFinite(Number(displayAmountRaw))
      ? Number(displayAmountRaw).toFixed(2)
      : String(displayAmountRaw);

    const payerLower = String(account || '').toLowerCase();
    const merchantLower = String(payment.merchant_wallet || '').toLowerCase();
    const feeLower = String(config.cryptonow.feeWallet || '').toLowerCase();
    if ((merchantLower && payerLower === merchantLower) || (feeLower && payerLower === feeLower)) {
      return res.status(400).json({ error: 'Self-payment is not allowed' });
    }

    const cacheKey = `${payment.id}:${payerLower}`;
    const cached = txCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({
        transaction: cached.transaction,
        message: `Payment - $${displayAmount}`
      });
    }

    try {
      await Promise.all([
        solanaService.ensureAtaForOwner(payment.merchant_wallet, 'USDC'),
        solanaService.ensureAtaForOwner(config.cryptonow.feeWallet, 'USDC')
      ]);
    } catch {}

    const merchantReceives = payment.merchant_receives ?? payment.amount;
    const feeAmount = payment.fee ?? solanaService.calculateFee(payment.amount);
    const precheck = await solanaService.precheckPayment(
      account,
      payment.merchant_wallet,
      merchantReceives,
      feeAmount,
      'USDC'
    );

    if (!precheck.ok) {
      return res.status(400).json({
        success: false,
        error: precheck.error || 'Transaction precheck failed',
        errorKey: precheck.errorKey || 'transaction_failed_retry'
      });
    }

    if (!payment.payment_reference) {
      payment.payment_reference = solanaService.generatePaymentReference();
      await payment.save();
    }

    const tx = await solanaService.createTransaction(
      account,
      payment.merchant_wallet,
      merchantReceives,
      feeAmount,
      'USDC',
      payment.payment_reference
    );

    const simulation = await solanaService.simulateTransaction(tx);
    if (!simulation.ok) {
      return res.status(400).json({
        success: false,
        error: 'Transaction simulation failed',
        errorKey: 'transaction_failed_retry'
      });
    }

    const serializedTx = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false
    });

    txCache.set(cacheKey, {
      transaction: serializedTx.toString('base64'),
      expiresAt: Date.now() + TX_CACHE_TTL_MS
    });

    return res.json({
      transaction: serializedTx.toString('base64'),
      message: `Payment - $${displayAmount}`
    });
  } catch {
    return res.status(500).json({ error: 'Failed to create transaction' });
  }
}
