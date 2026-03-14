import { useState } from 'react';
import { useAppKitAccount, useAppKitProvider } from '@reown/appkit/react';
import { useAppKitConnection, type Provider } from '@reown/appkit-adapter-solana/react';
import { Transaction } from '@solana/web3.js';
import { Buffer } from 'buffer';

const SERVER_URL = import.meta.env.VITE_SERVER_URL;

interface PhantomProvider {
  isPhantom?: boolean;
  publicKey?: {
    toBase58(): string;
  };
  signAndSendTransaction?: (
    transaction: Transaction
  ) => Promise<{ signature: string } | string>;
}

const getActivePhantomProvider = (walletAddress: string): PhantomProvider | null => {
  const phantomProvider = (window as typeof window & {
    phantom?: { solana?: PhantomProvider };
  })?.phantom?.solana;

  if (!phantomProvider?.isPhantom || !phantomProvider?.publicKey || !phantomProvider?.signAndSendTransaction) {
    return null;
  }

  const phantomAddress = phantomProvider.publicKey.toBase58?.();
  if (!phantomAddress || phantomAddress.toLowerCase() !== walletAddress.toLowerCase()) {
    return null;
  }

  return phantomProvider;
};

const extractSignature = (result: { signature: string } | string): string =>
  typeof result === 'string' ? result : result.signature;

export function usePhantomPaymentFlow() {
  const [isProcessing, setIsProcessing] = useState(false);
  const { isConnected } = useAppKitAccount();
  const { connection } = useAppKitConnection();
  const { walletProvider } = useAppKitProvider<Provider>('solana');

  const pay = async (sessionKey: string, walletAddress: string) => {
    if (!isConnected || !walletProvider || !connection) {
      return { success: false, error: 'Wallet not connected', errorKey: 'wallet_not_connected' };
    }

    setIsProcessing(true);
    try {
      const stateResponse = await fetch(`${SERVER_URL}/api/payment/${sessionKey}/state`);
      const stateData = await stateResponse.json();
      if (!stateResponse.ok || !stateData?.success) {
        return { success: false, error: 'Session status check failed', errorKey: 'session_status_failed' };
      }
      if (stateData?.data?.uiState === 'completed' || stateData?.data?.tx_hash) {
        return { success: false, error: 'Session already paid', errorKey: 'session_already_paid' };
      }

      const txResponse = await fetch(`${SERVER_URL}/api/payment/merchant/${sessionKey}/transaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: walletAddress })
      });

      const txPayload = await txResponse.json();
      if (!txResponse.ok || !txPayload?.transaction) {
        return { success: false, error: txPayload?.error || 'Transaction create failed', errorKey: txPayload?.errorKey || 'transaction_create_failed' };
      }

      const transaction = Transaction.from(Buffer.from(txPayload.transaction, 'base64'));
      const phantomProvider = getActivePhantomProvider(walletAddress);
      const phantomSignAndSend = phantomProvider?.signAndSendTransaction;
      const signature = phantomProvider
        ? extractSignature(await phantomSignAndSend!(transaction))
        : await walletProvider.sendTransaction(
            transaction as unknown as Parameters<typeof walletProvider.sendTransaction>[0],
            connection as Parameters<typeof walletProvider.sendTransaction>[1]
          );

      const confirmResponse = await fetch(`${SERVER_URL}/api/payment/${sessionKey}/confirm-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress, transactionId: signature })
      });
      const confirmPayload = await confirmResponse.json();
      if (!confirmResponse.ok || !confirmPayload?.success) {
        return { success: false, error: confirmPayload?.error || 'Payment record failed', errorKey: 'payment_record_failed' };
      }

      return { success: true, transactionId: signature };
    } catch (e: any) {
      const msg = String(e?.message || '').toLowerCase();
      if (msg.includes('user rejected')) return { success: false, error: 'Rejected by user', errorKey: 'transaction_rejected' };
      if (msg.includes('insufficient funds')) return { success: false, error: 'Insufficient funds', errorKey: 'insufficient_funds' };
      return { success: false, error: 'Transaction failed', errorKey: 'transaction_failed' };
    } finally {
      setIsProcessing(false);
    }
  };

  return { pay, isProcessing };
}
