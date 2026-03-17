import { useState } from 'react';
import { useAppKitAccount, useAppKitProvider } from '@reown/appkit/react';
import { useAppKitConnection, type Provider } from '@reown/appkit-adapter-solana/react';
import { Transaction } from '@solana/web3.js';
import { Buffer } from 'buffer';

const SERVER_URL = import.meta.env.VITE_SERVER_URL;

interface PaymentTransactionResult {
  success: boolean;
  transactionId?: string;
  pendingConfirmation?: boolean;
  error?: string;
  errorKey?: string;
}

interface PhantomProvider {
  isPhantom?: boolean;
  publicKey?: {
    toBase58(): string;
  };
  signAndSendTransaction?: (
    transaction: Transaction
  ) => Promise<{ signature: string } | string>;
}

const getPhantomProviderState = (walletAddress: string): {
  matched: boolean;
  provider: PhantomProvider | null;
} => {
  const phantomProvider = (window as typeof window & {
    phantom?: { solana?: PhantomProvider };
  })?.phantom?.solana;

  if (!phantomProvider?.isPhantom || !phantomProvider?.publicKey) {
    return { matched: false, provider: null };
  }

  const phantomAddress = phantomProvider.publicKey.toBase58?.();
  if (!phantomAddress || phantomAddress.toLowerCase() !== walletAddress.toLowerCase()) {
    return { matched: false, provider: null };
  }

  if (!phantomProvider.signAndSendTransaction) {
    return { matched: true, provider: null };
  }

  return { matched: true, provider: phantomProvider };
};

const extractSignature = (result: { signature: string } | string): string =>
  typeof result === 'string' ? result : result.signature;

export function usePhantomPaymentFlow() {
  const [isProcessing, setIsProcessing] = useState(false);
  const { isConnected } = useAppKitAccount();
  const { connection } = useAppKitConnection();
  const { walletProvider } = useAppKitProvider<Provider>('solana');

  const pay = async (sessionKey: string, walletAddress: string): Promise<PaymentTransactionResult> => {
    if (!isConnected || !walletProvider || !connection) {
      return {
        success: false,
        error: 'Wallet not connected. Please connect your wallet first.',
        errorKey: 'wallet_not_connected'
      };
    }

    setIsProcessing(true);

    try {
      const stateResponse = await fetch(`${SERVER_URL}/api/payment/${sessionKey}/state`);
      if (!stateResponse.ok) {
        return {
          success: false,
          error: 'Unable to verify session status. Please try again.',
          errorKey: 'session_status_failed'
        };
      }

      const stateData = await stateResponse.json();
      if (!stateData?.success) {
        return {
          success: false,
          error: 'Session status check failed. Please try again.',
          errorKey: 'session_status_failed'
        };
      }

      const currentState = stateData.data;
      if (currentState?.uiState === 'completed' || currentState?.tx_hash) {
        return {
          success: false,
          error: 'This session is already paid.',
          errorKey: 'session_already_paid'
        };
      }

      const txResponse = await fetch(`${SERVER_URL}/api/payment/merchant/${sessionKey}/transaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: walletAddress })
      });

      if (!txResponse.ok) {
        let payload: any = null;
        try {
          payload = await txResponse.json();
        } catch {
          payload = null;
        }

        return {
          success: false,
          error: payload?.error || 'Failed to create transaction from server',
          errorKey: payload?.errorKey || 'transaction_create_failed'
        };
      }

      const { transaction: base64Tx } = await txResponse.json();
      const txBuffer = Buffer.from(base64Tx, 'base64');
      const transaction = Transaction.from(txBuffer);
      const phantomState = getPhantomProviderState(walletAddress);

      if (phantomState.matched && !phantomState.provider) {
        return {
          success: false,
          error: 'Phantom signAndSendTransaction is unavailable.',
          errorKey: 'phantom_sign_and_send_unavailable'
        };
      }

      const signature = phantomState.provider
        ? extractSignature(await phantomState.provider.signAndSendTransaction!(transaction))
        : await walletProvider.sendTransaction(
            transaction as unknown as Parameters<typeof walletProvider.sendTransaction>[0],
            connection as Parameters<typeof walletProvider.sendTransaction>[1]
          );

      const payResponse = await fetch(`${SERVER_URL}/api/payment/${sessionKey}/confirm-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress,
          transactionId: signature
        })
      });

      const payData = await payResponse.json();
      if (payData?.success && payData?.pending) {
        return {
          success: true,
          transactionId: signature,
          pendingConfirmation: true
        };
      }

      if (!payResponse.ok || !payData?.success) {
        return {
          success: false,
          error: payData?.error || 'Payment recording failed',
          errorKey: 'payment_record_failed'
        };
      }

      return { success: true, transactionId: signature };
    } catch (error: any) {
      if (error?.message?.includes('User rejected')) {
        return { success: false, error: 'Transaction rejected by user', errorKey: 'transaction_rejected' };
      }

      if (error?.message?.includes('403') || error?.message?.includes('Forbidden')) {
        return {
          success: false,
          error: 'RPC rate limit. Please try again or contact support.',
          errorKey: 'rpc_rate_limit'
        };
      }

      const message = String(error?.message || '').toLowerCase();
      if (message.includes('insufficient funds')) {
        return {
          success: false,
          error: 'Not enough funds in the wallet for this payment.',
          errorKey: 'insufficient_funds'
        };
      }
      if (message.includes('simulation failed') || message.includes('custom program error')) {
        return {
          success: false,
          error: 'Transaction failed. Please try again or use another wallet.',
          errorKey: 'transaction_failed_retry'
        };
      }

      return {
        success: false,
        error: 'Transaction failed. Please try again.',
        errorKey: 'transaction_failed'
      };
    } finally {
      setIsProcessing(false);
    }
  };

  return {
    pay,
    isProcessing
  };
}
