import express from 'express';
import { generateSolanaPayQr, getSolanaPayMetadata } from './phantom_qr_backend.js';
import {
  createUnsignedPaymentTransaction,
  confirmSignedPayment
} from './phantom_payment_backend.js';
import { getPaymentSessionState } from './phantom_payment_state.js';

const router = express.Router();

router.get('/api/payment/:sessionKey/state', getPaymentSessionState);
router.post('/api/payment/:sessionKey/qr', generateSolanaPayQr);
router.get('/api/payment/merchant/:sessionKey/transaction', getSolanaPayMetadata);
router.post('/api/payment/merchant/:sessionKey/transaction', createUnsignedPaymentTransaction);
router.post('/api/payment/:sessionKey/confirm-payment', confirmSignedPayment);

export default router;
