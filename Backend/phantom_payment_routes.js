import express from 'express';
import {
  generatePaymentQR,
  getMerchantPaymentInfo
} from './phantom_qr_backend.js';
import {
  createMerchantTransaction
} from './phantom_payment_backend.js';

const router = express.Router();

router.post('/api/payment/:sessionKey/qr', generatePaymentQR);
router.get('/api/payment/merchant/:sessionKey/transaction', getMerchantPaymentInfo);
router.post('/api/payment/merchant/:sessionKey/transaction', createMerchantTransaction);

export default router;
