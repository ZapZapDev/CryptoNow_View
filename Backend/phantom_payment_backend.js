import { isUuid } from '../utils/validation.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import { solanaBuilder } from './phantom_solana_builder.js';

const txCache = new Map();
const TX_CACHE_TTL_MS = 60 * 1000;

export async function createUnsignedPaymentTransaction(req, res) {
  try {
    const { sessionKey } = req.params;
    const { account } = req.body;

    if (!account || !solanaBuilder.validateAddress(account)) {
      return res.status(400).json({ success: false, error: 'Invalid wallet address' });
    }
    if (!isUuid(sessionKey)) {
      return res.status(400).json({ success: false, error: 'Invalid session key' });
    }

    const session = await Session.findOne({ where: { session_key: sessionKey } });
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

    let payment = session.payment_id
      ? await Payment.findByPk(session.payment_id)
      : await Payment.findOne({ where: { session_id: session.id }, order: [['created_at', 'DESC']] });
    if (!payment) return res.status(404).json({ success: false, error: 'Payment not found' });

    if (payment.transaction_status === 'paid' || payment.txid || session.ui_state === 'completed') {
      return res.status(409).json({ success: false, error: 'Payment already completed' });
    }

    const cacheKey = `${payment.id}:${String(account).toLowerCase()}`;
    const cached = txCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({ success: true, transaction: cached.transaction });
    }

    const merchantReceives = payment.merchant_receives ?? payment.amount;
    const feeAmount = payment.fee ?? solanaBuilder.calculateFee(payment.amount);

    const precheck = await solanaBuilder.precheckUsdcPayment({
      payerAddress: account,
      merchantAddress: payment.merchant_wallet,
      merchantAmount: merchantReceives,
      feeAmount
    });
    if (!precheck.ok) {
      return res.status(400).json({ success: false, error: precheck.error, errorKey: precheck.errorKey });
    }

    if (!payment.payment_reference) {
      payment.payment_reference = solanaBuilder.generatePaymentReference();
      await payment.save();
    }

    const tx = await solanaBuilder.createUsdcSplitTransaction({
      payerAddress: account,
      merchantAddress: payment.merchant_wallet,
      merchantAmount: merchantReceives,
      feeAmount,
      reference: payment.payment_reference
    });

    const simulation = await solanaBuilder.simulateTransaction(tx);
    if (!simulation.ok) {
      return res.status(400).json({ success: false, error: 'Transaction simulation failed', errorKey: 'transaction_failed_retry' });
    }

    const serializedTx = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false
    }).toString('base64');

    txCache.set(cacheKey, { transaction: serializedTx, expiresAt: Date.now() + TX_CACHE_TTL_MS });

    return res.json({ success: true, transaction: serializedTx });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to create transaction' });
  }
}

export async function confirmSignedPayment(req, res) {
  try {
    const { sessionKey } = req.params;
    const { walletAddress, transactionId } = req.body;

    if (!isUuid(sessionKey)) return res.status(400).json({ success: false, error: 'Invalid session key' });
    if (!walletAddress || !transactionId) {
      return res.status(400).json({ success: false, error: 'Missing walletAddress or transactionId' });
    }

    const session = await Session.findOne({ where: { session_key: sessionKey } });
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

    const payment = session.payment_id
      ? await Payment.findByPk(session.payment_id)
      : await Payment.findOne({ where: { session_id: session.id }, order: [['created_at', 'DESC']] });
    if (!payment) return res.status(404).json({ success: false, error: 'Payment not found' });

    payment.payer_wallet = walletAddress;
    payment.txid = transactionId;
    await payment.save();

    return res.json({ success: true, txid: transactionId });
  } catch {
    return res.status(500).json({ success: false, error: 'Payment confirmation failed' });
  }
}
