import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import { isUuid } from '../utils/validation.js';

export async function getPaymentSessionState(req, res) {
  try {
    const { sessionKey } = req.params;

    if (!isUuid(sessionKey)) {
      return res.status(400).json({ success: false, error: 'Invalid session key' });
    }

    const session = await Session.findOne({ where: { session_key: sessionKey } });
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const payment = await Payment.findOne({ where: { session_id: session.id } });
    const isPaid = Boolean(payment && (payment.transaction_status === 'paid' || payment.txid));

    return res.json({
      success: true,
      data: {
        uiState: isPaid ? 'completed' : session.ui_state,
        tx_hash: payment?.txid || null
      }
    });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to load session state' });
  }
}
