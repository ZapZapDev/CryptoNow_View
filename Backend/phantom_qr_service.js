import QRCode from 'qrcode';

export class PhantomQrService {
  constructor({ baseUrl }) {
    this.baseUrl = baseUrl;
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
    if (data.startsWith('solana:')) return;

    const protocol = new URL(data).protocol;
    if (protocol !== 'https:') {
      throw new Error('Invalid QR data - unsupported scheme');
    }
  }

  createSolanaPayUrl(sessionKey) {
    const transactionUrl = `${this.baseUrl}/api/payment/merchant/${sessionKey}/transaction`;
    return `${this.SOLANA_PREFIX}${transactionUrl}`;
  }

  async generatePaymentQr(sessionKey) {
    const solanaPayUrl = this.createSolanaPayUrl(sessionKey);
    this.ensureAllowedScheme(solanaPayUrl);
    return QRCode.toDataURL(solanaPayUrl, this.qrOptions);
  }
}
