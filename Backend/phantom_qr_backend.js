import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import qrService from './phantom_qr_service.js';
import { isUuid } from '../utils/validation.js';

const config = {
  frontendUrl: process.env.FRONTEND_URL
};

export async function generatePaymentQR(req, res) {
  try {
    const { sessionKey } = req.params;

    if (!isUuid(sessionKey)) {
      return res.status(400).json({ success: false, error: 'Invalid session key' });
    }

    const session = await Session.findActiveByKey(sessionKey);
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const payment = await Payment.findOne({ where: { session_id: session.id } });
    if (!payment) {
      return res.status(404).json({ success: false, error: 'Payment not found' });
    }

    const paymentUrl = `${process.env.FRONTEND_URL}/Payment?session=${session.session_key}`;
    const qrCode = await qrService.createPaymentQR(session.session_key);

    if (!session.started_at || session.status === 'pending') {
      await session.update({
        status: 'active',
        started_at: session.started_at || new Date()
      });
    }

    if (session.ui_state === 'choose') {
      await session.transitionTo('payment');
    }

    return res.json({
      success: true,
      qr_code: qrCode,
      url: paymentUrl
    });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to generate QR' });
  }
}

export async function getMerchantPaymentInfo(req, res) {
  try {
    const { sessionKey } = req.params;

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

    return res.json({
      label: 'CryptoNow Payment',
      icon: `${config.frontendUrl}/logo.png`
    });
  } catch {
    return res.status(500).json({ error: 'Internal server error' });
  }
}
