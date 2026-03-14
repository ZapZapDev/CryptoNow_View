import { useState } from 'react';

const SERVER_URL = import.meta.env.VITE_SERVER_URL;

export function usePhantomSolanaPayQr() {
  const [isLoading, setIsLoading] = useState(false);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [sessionUrl, setSessionUrl] = useState<string | null>(null);

  const loadQr = async (sessionKey: string) => {
    setIsLoading(true);
    try {
      const response = await fetch(`${SERVER_URL}/api/payment/${sessionKey}/qr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      const payload = await response.json();
      if (!response.ok || !payload?.success) {
        return { success: false, error: payload?.error || 'QR generation failed' };
      }

      setQrCode(payload.qr_code || null);
      setSessionUrl(payload.url || null);

      return {
        success: true,
        qrCode: payload.qr_code || null,
        url: payload.url || null
      };
    } catch {
      return { success: false, error: 'QR generation failed' };
    } finally {
      setIsLoading(false);
    }
  };

  return {
    loadQr,
    isLoading,
    qrCode,
    sessionUrl
  };
}
