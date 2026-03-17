import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import QRCode from '../models/QRCode.js';
import { isUuid } from '../utils/validation.js';

function formatMoney(value) {
  return Number(Number(value || 0).toFixed(2)).toFixed(2);
}

export async function getPaymentSessionState(req, res) {
  try {
    const { sessionKey } = req.params;

    if (!isUuid(sessionKey)) {
      return res.status(400).json({ success: false, error: 'Invalid session key' });
    }

    const session = await Session.findOne({
      where: { session_key: sessionKey },
      include: [{ model: QRCode, as: 'qrCode', required: false, paranoid: false }]
    });

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found or expired' });
    }

    let payment = null;
    let isPaid = false;
    if (session.payment_id) {
      payment = await Payment.findByPk(session.payment_id);
    }
    if (!payment && session.id) {
      payment = await Payment.findOne({ where: { session_id: session.id }, order: [['created_at', 'DESC']] });
    }
    if (payment) {
      const paidByPayment = payment.transaction_status === 'paid' || payment.paid_at || payment.txid;
      isPaid = Boolean(paidByPayment || session.ui_state === 'completed');
    }
    if (!isPaid && session.ui_state === 'completed') {
      isPaid = true;
    }

    const timeLeft = session.expired_at && session.isActive()
      ? Math.max(0, Math.floor((new Date(session.expired_at) - Date.now()) / 1000))
      : 0;

    const uiState = isPaid ? 'completed' : (session.isActive() ? session.ui_state : 'unpaid');

    const responseData = {
      uiState,
      sessionKey: session.session_key,
      sessionType: session.session_type,
      expiredAt: session.expired_at,
      timeLeft,
      returnUrl: session.return_url || null,
      success_url: isPaid ? session.success_url : null
    };

    if (session.qrCode) {
      responseData.qrId = session.qrCode.qr_unique_id;
    }

    if (payment) {
      const recipientWallet = payment.recipient_wallet || payment.merchant_wallet || null;
      responseData.payment = {
        id: payment.id,
        amount: formatMoney(payment.amount),
        fee: formatMoney(payment.fee),
        merchant_receives: formatMoney(payment.merchant_receives),
        total_amount: formatMoney(payment.total_amount ?? payment.amount),
        currency: payment.currency,
        recipient_wallet: recipientWallet
      };

      if (payment.txid) {
        responseData.tx_hash = payment.txid;
        responseData.solscan_url = `https://solscan.io/tx/${payment.txid}`;
      }
    }

    return res.status(200).json({ success: true, data: responseData });
  } catch {
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}
