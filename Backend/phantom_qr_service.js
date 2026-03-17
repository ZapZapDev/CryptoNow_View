import QRCode from 'qrcode';

const config = {
  baseUrl: process.env.PUBLIC_BASE_URL,
  frontendUrl: process.env.FRONTEND_URL
};

class PhantomQrService {
  constructor() {
    this.SOLANA_PREFIX = 'solana:';
    this.qrOptions = {
      type: '',
      quality: 0.92,
      margin: 1,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      },
      width: 400,
      errorCorrectionLevel: 'M'
    };
  }

  ensureAllowedScheme(data) {
    const allowed = new Set(['solana:', 'https:']);
    if (process.env.NODE_ENV !== 'PROD' || config.frontendUrl?.startsWith('http://')) {
      allowed.add('http:');
    }

    if (data.startsWith('solana:')) {
      return;
    }

    const protocol = new URL(data).protocol;
    if (!allowed.has(protocol)) {
      throw new Error('Invalid QR data - unsupported scheme');
    }
  }

  async generateQR(data) {
    this.ensureAllowedScheme(data);
    return QRCode.toDataURL(data, this.qrOptions);
  }

  resolveBaseUrl() {
    const rawBaseUrl = String(config.baseUrl || '').trim();
    if (!rawBaseUrl) {
      throw new Error('BASE_URL is not configured');
    }

    const baseUrl = new URL(rawBaseUrl);
    if (process.env.NODE_ENV === 'PROD' && baseUrl.protocol !== 'https:') {
      throw new Error('BASE_URL must use https in production');
    }

    return baseUrl;
  }

  createSolanaPayUrl(sessionKey) {
    const baseUrl = this.resolveBaseUrl();
    const transactionUrl = new URL(`/api/payment/merchant/${encodeURIComponent(sessionKey)}/transaction`, baseUrl);
    return `${this.SOLANA_PREFIX}${transactionUrl.toString()}`;
  }

  async createPaymentQR(sessionKey) {
    return this.generateQR(this.createSolanaPayUrl(sessionKey));
  }
}

export default new PhantomQrService();
