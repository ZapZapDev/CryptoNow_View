import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import { isUuid } from '../utils/validation.js';
import { PhantomQrService } from './phantom_qr_service.js';

const qrService = new PhantomQrService({
  baseUrl: process.env.PUBLIC_BASE_URL
});

export async function generateSolanaPayQr(req, res) {
  try {
    const { sessionKey } = req.params;

    if (!isUuid(sessionKey)) {
      return res.status(400).json({ success: false, error: 'Invalid session key' });
    }

    const session = await Session.findOne({ where: { session_key: sessionKey } });
    if (!session || !session.isActive()) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const payment = await Payment.findOne({ where: { session_id: session.id } });
    if (!payment) {
      return res.status(404).json({ success: false, error: 'Payment not found' });
    }

    const qrCode = await qrService.generatePaymentQr(session.session_key);
    const url = `${process.env.FRONTEND_URL}/Payment?session=${session.session_key}`;

    return res.json({
      success: true,
      qr_code: qrCode,
      url
    });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to generate QR' });
  }
}

export async function getSolanaPayMetadata(req, res) {
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
    if (!payment) {
      return res.status(404).json({ success: false, error: 'Payment not found' });
    }

    return res.json({
      label: 'CryptoNow Payment',
      icon: `${process.env.FRONTEND_URL}/favicon.png`
    });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to load metadata' });
  }
}
