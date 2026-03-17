import { Op } from 'sequelize';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import solanaService from './phantom_solana_service.js';
import blockchainMonitor from './phantom_blockchain_monitor.js';
import { log, LogLevel } from './phantom_logging.js';
import { getClientIp } from './phantom_request_helpers.js';
import { isUuid } from '../utils/validation.js';

const config = {
  cryptonow: {
    feeWallet: process.env.CRYPTONOW_FEE_WALLET
  }
};

const txCache = new Map();
const TX_CACHE_TTL_MS = 60 * 1000;

function buildRequestDebugMeta(req) {
  return {
    method: req.method,
    path: req.originalUrl || req.url,
    ip: getClientIp(req),
    host: req.get?.('host') || req.headers?.host || null,
    origin: req.get?.('origin') || req.headers?.origin || null,
    referer: req.get?.('referer') || req.headers?.referer || null,
    userAgent: req.get?.('user-agent') || req.headers?.['user-agent'] || null,
    contentType: req.get?.('content-type') || req.headers?.['content-type'] || null,
    forwardedProto: req.get?.('x-forwarded-proto') || req.headers?.['x-forwarded-proto'] || null,
    forwardedHost: req.get?.('x-forwarded-host') || req.headers?.['x-forwarded-host'] || null
  };
}

function summarizeTransaction(transaction) {
  if (!transaction) return null;

  const instructions = Array.isArray(transaction.instructions) ? transaction.instructions : [];
  return {
    feePayer: transaction.feePayer?.toBase58?.() || null,
    recentBlockhash: transaction.recentBlockhash || null,
    instructionCount: instructions.length,
    serializedSize: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).length,
    programs: instructions.map((instruction) => instruction.programId?.toBase58?.() || null),
    instructions: instructions.map((instruction, index) => ({
      index,
      programId: instruction.programId?.toBase58?.() || null,
      keyCount: Array.isArray(instruction.keys) ? instruction.keys.length : 0,
      dataLength: instruction.data?.length || 0,
      keys: Array.isArray(instruction.keys)
        ? instruction.keys.map((key) => ({
            pubkey: key.pubkey?.toBase58?.() || null,
            isSigner: Boolean(key.isSigner),
            isWritable: Boolean(key.isWritable)
          }))
        : []
    }))
  };
}

export async function createMerchantTransaction(req, res) {
  try {
    const { sessionKey } = req.params;
    const { account } = req.body;
    const requestMeta = buildRequestDebugMeta(req);

    log(LogLevel.DEBUG, 'payment.transaction.request', {
      sessionKey,
      payerWallet: account || null,
      request: requestMeta
    });

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
      payment = await Payment.findOne({ where: { session_id: session.id }, order: [['created_at', 'DESC']] });
    }
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    log(LogLevel.DEBUG, 'payment.transaction.context', {
      sessionKey: session.session_key,
      sessionId: session.id,
      sessionStatus: session.status,
      sessionType: session.session_type,
      sessionUiState: session.ui_state,
      sessionStartedAt: session.started_at,
      sessionExpiredAt: session.expired_at,
      paymentId: payment.id,
      paymentStatus: payment.transaction_status,
      orderId: payment.order_id,
      amount: payment.amount,
      totalAmount: payment.total_amount,
      merchantReceives: payment.merchant_receives,
      feeAmount: payment.fee,
      assetSymbol: payment.token || payment.currency || 'USDC',
      merchantWallet: payment.merchant_wallet,
      feeWallet: config.cryptonow.feeWallet,
      paymentReference: payment.payment_reference || null,
      request: requestMeta
    });

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
      return res.json({ transaction: cached.transaction, message: `Payment - $${displayAmount}` });
    }

    try {
      await Promise.all([
        solanaService.ensureAtaForOwner(payment.merchant_wallet, 'USDC'),
        solanaService.ensureAtaForOwner(config.cryptonow.feeWallet, 'USDC')
      ]);
    } catch (err) {
      log(LogLevel.WARN, 'payment.transaction.ata.ensure_failed', { error: err.message });
    }

    const merchantReceives = payment.merchant_receives ?? payment.amount;
    const feeAmount = payment.fee ?? solanaService.calculateFee(payment.amount);
    const precheck = await solanaService.precheckPayment(account, payment.merchant_wallet, merchantReceives, feeAmount, 'USDC');

    log(LogLevel.DEBUG, 'payment.transaction.precheck_result', {
      sessionKey,
      paymentId: payment.id,
      payerWallet: account,
      merchantWallet: payment.merchant_wallet,
      merchantReceives,
      feeAmount,
      ok: precheck.ok,
      error: precheck.error || null,
      errorKey: precheck.errorKey || null,
      details: precheck.details || null
    });

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

    const tx = await solanaService.createTransaction(account, payment.merchant_wallet, merchantReceives, feeAmount, 'USDC', payment.payment_reference);

    log(LogLevel.DEBUG, 'payment.transaction.reference_attached', {
      sessionKey: session.session_key,
      paymentId: payment.id,
      paymentReference: payment.payment_reference
    });

    log(LogLevel.DEBUG, 'payment.transaction.built', {
      sessionKey,
      paymentId: payment.id,
      payerWallet: account,
      merchantWallet: payment.merchant_wallet,
      merchantReceives,
      feeAmount,
      paymentReference: payment.payment_reference,
      transaction: summarizeTransaction(tx)
    });

    const simulation = await solanaService.simulateTransaction(tx);
    log(LogLevel.DEBUG, 'payment.transaction.simulation_result', {
      sessionKey,
      paymentId: payment.id,
      ok: simulation.ok,
      error: simulation.error || null,
      logs: Array.isArray(simulation.logs) ? simulation.logs.slice(0, 80) : []
    });

    if (!simulation.ok) {
      return res.status(400).json({
        success: false,
        error: 'Transaction simulation failed',
        errorKey: 'transaction_failed_retry'
      });
    }

    const serializedTx = tx.serialize({ requireAllSignatures: false, verifySignatures: false });

    txCache.set(cacheKey, {
      transaction: serializedTx.toString('base64'),
      expiresAt: Date.now() + TX_CACHE_TTL_MS
    });

    log(LogLevel.DEBUG, 'payment.transaction.response', {
      sessionKey,
      paymentId: payment.id,
      payerWallet: account,
      transactionSize: serializedTx.length,
      cacheTtlMs: TX_CACHE_TTL_MS
    });

    return res.json({
      transaction: serializedTx.toString('base64'),
      message: `Payment - $${displayAmount}`
    });
  } catch (err) {
    log(LogLevel.ERROR, 'payment.transaction.create.error', {
      sessionKey: req.params?.sessionKey || null,
      payerWallet: req.body?.account || null,
      request: buildRequestDebugMeta(req),
      error: err.message
    });
    return res.status(500).json({ error: 'Failed to create transaction' });
  }
}

export async function confirmPayment(req, res) {
  try {
    const { sessionKey } = req.params;
    const { walletAddress, transactionId } = req.body;
    const requestMeta = buildRequestDebugMeta(req);

    log(LogLevel.DEBUG, 'payment.confirm.request', {
      sessionKey,
      walletAddress: walletAddress || null,
      transactionId: transactionId || null,
      request: requestMeta
    });

    if (!isUuid(sessionKey)) {
      return res.status(400).json({ success: false, error: 'Invalid session key' });
    }

    if (!walletAddress || !transactionId) {
      return res.status(400).json({ success: false, error: 'Missing walletAddress or transactionId' });
    }

    if (!solanaService.validateAddress(walletAddress)) {
      return res.status(400).json({ success: false, error: 'Invalid wallet address' });
    }

    const session = await Session.findOne({ where: { session_key: sessionKey } });
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const payment = await Payment.findOne({ where: { session_id: session.id } });
    if (!payment) {
      return res.status(404).json({ success: false, error: 'Payment not found' });
    }

    const merchantWallet = String(payment.merchant_wallet || '').toLowerCase();
    const providedWallet = String(walletAddress || '').toLowerCase();
    if (merchantWallet && providedWallet && merchantWallet === providedWallet) {
      return res.json({ success: false, error: 'Self-payment is not allowed. Please connect another wallet.' });
    }

    const isPaid = payment.transaction_status === 'paid' || payment.txid || session.ui_state === 'completed';
    if (isPaid) {
      if (payment.txid && payment.txid === transactionId) {
        return res.json({
          success: true,
          transactionId: payment.txid,
          payment: {
            id: payment.id,
            payer_wallet: payment.payer_wallet,
            amount: payment.amount,
            currency: payment.currency,
            status: 'paid'
          }
        });
      }
      return res.status(409).json({ success: false, error: 'Session already paid' });
    }

    if (session.txid_submitted) {
      return res.status(400).json({ success: false, error: 'Payment attempt already used for this session' });
    }

    const existingPayment = await Payment.findOne({
      where: {
        txid: transactionId,
        id: { [Op.ne]: payment.id }
      }
    });

    if (existingPayment) {
      return res.status(409).json({ success: false, error: 'Transaction already used' });
    }

    const minBlockTime = session.created_at ? Math.floor(new Date(session.created_at).getTime() / 1000) : null;

    const verification = await solanaService.verifyTransaction(transactionId, payment.merchant_wallet, payment.amount, {
      minBlockTime,
      commitment: 'confirmed',
      expectedMerchantReceives: payment.merchant_receives,
      retryDelays: [1500, 2500, 4000]
    });

    log(LogLevel.DEBUG, 'payment.confirm.verification_result', {
      sessionKey,
      paymentId: payment.id,
      transactionId,
      verified: verification.verified,
      error: verification.error || null,
      details: verification.details || null
    });

    if (!verification.verified) {
      const errorText = String(verification.error || '').toLowerCase();
      const isPendingVerification = errorText.includes('not found') || errorText.includes('block time missing');

      if (isPendingVerification) {
        return res.json({ success: true, pending: true, transactionId });
      }

      return res.status(400).json({ success: false, error: 'Transaction verification failed' });
    }

    const payerWallet = String(verification?.details?.payer || walletAddress || '').toLowerCase();
    if (merchantWallet && payerWallet && merchantWallet === payerWallet) {
      return res.json({ success: false, error: 'Self-payment is not allowed. Please connect another wallet.' });
    }

    await payment.update({ payer_wallet: walletAddress });
    await blockchainMonitor.confirmPayment(payment.id, transactionId);
    await session.update({ txid_submitted: true });

    return res.json({
      success: true,
      transactionId,
      payment: {
        id: payment.id,
        payer_wallet: payment.payer_wallet,
        amount: payment.amount,
        currency: payment.currency,
        status: 'paid'
      }
    });
  } catch (err) {
    log(LogLevel.ERROR, 'payment.confirm.error', {
      sessionKey: req.params?.sessionKey || null,
      walletAddress: req.body?.walletAddress || null,
      transactionId: req.body?.transactionId || null,
      request: buildRequestDebugMeta(req),
      error: err.message
    });
    return res.status(500).json({ success: false, error: 'Failed to process payment' });
  }
}
