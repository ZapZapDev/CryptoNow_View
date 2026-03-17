import express from 'express';
import { getPaymentSessionState } from './phantom_payment_state.js';
import {
  generatePaymentQR,
  getMerchantPaymentInfo
} from './phantom_qr_backend.js';
import {
  createMerchantTransaction,
  confirmPayment
} from './phantom_payment_backend.js';

const router = express.Router();

router.get('/api/payment/:sessionKey/state', getPaymentSessionState);
router.post('/api/payment/:sessionKey/qr', generatePaymentQR);
router.post('/api/payment/:sessionKey/confirm-payment', confirmPayment);
router.get('/api/payment/merchant/:sessionKey/transaction', getMerchantPaymentInfo);
router.post('/api/payment/merchant/:sessionKey/transaction', createMerchantTransaction);

export default router;
