import {
  PublicKey,
  Keypair,
  Transaction
} from '@solana/web3.js';
import {
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID
} from '@solana/spl-token';

const config = {
  cryptonow: {
    feeFixed: Number(process.env.CRYPTONOW_FEE_FIXED || 0.01),
    feeWallet: process.env.CRYPTONOW_FEE_WALLET
  },
  tokens: {
    USDC: {
      mint: process.env.USDC_MINT,
      decimals: Number(process.env.USDC_DECIMALS || 6)
    }
  },
  helius: {
    apiKey: process.env.HELIUS_API_KEY
  }
};

export function calculateFee(amount) {
  const safeAmount = Number(amount);
  if (!Number.isFinite(safeAmount) || safeAmount <= 0) {
    return config.cryptonow.feeFixed;
  }
  const stepped = Math.floor(safeAmount);
  const fee = Math.max(config.cryptonow.feeFixed, stepped * config.cryptonow.feeFixed);
  return Number(fee.toFixed(2));
}

export function toBaseUnits(value, decimals) {
  const raw = String(value ?? '0');
  const [wholePart, fracPart = ''] = raw.split('.');
  const safeWhole = wholePart && wholePart.length ? wholePart : '0';
  const safeFrac = fracPart.padEnd(decimals, '0').slice(0, decimals);
  const combined = `${safeWhole}${safeFrac}`.replace(/^0+(?=\d)/, '');
  return BigInt(combined || '0');
}

export function generatePaymentReference() {
  return Keypair.generate().publicKey.toBase58();
}

export function appendReference(transaction, reference) {
  if (!reference) return;
  const referenceKey = new PublicKey(reference);
  for (const instruction of transaction.instructions) {
    const alreadyExists = instruction.keys.some((key) => key.pubkey.equals(referenceKey));
    if (!alreadyExists) {
      instruction.keys.push({ pubkey: referenceKey, isSigner: false, isWritable: false });
    }
  }
}

export async function createTransaction(service, payerAddress, merchantAddress, merchantAmount, feeAmount, token = 'USDC', reference = null) {
  const payer = new PublicKey(payerAddress);
  const merchant = new PublicKey(merchantAddress);
  const feeWallet = new PublicKey(config.cryptonow.feeWallet);
  const tokenConfig = config.tokens[token];

  if (!tokenConfig) throw new Error(`Token ${token} not supported`);

  const tokenMint = new PublicKey(tokenConfig.mint);
  const payerTokenAccount = await service.getExistingTokenAccount(payer, tokenMint);
  const merchantTokenAccount = await service.getExistingTokenAccount(merchant, tokenMint);
  const feeTokenAccount = await service.getExistingTokenAccount(feeWallet, tokenMint);

  if (!payerTokenAccount) throw new Error('Payer USDC token account not found');
  if (!merchantTokenAccount) throw new Error('Merchant USDC token account not found');
  if (!feeTokenAccount) throw new Error('Fee USDC token account not found');

  const merchantAmountUnits = Math.floor(Number(Number(merchantAmount).toFixed(2)) * 10 ** tokenConfig.decimals);
  const feeAmountUnits = Math.floor(Number(Number(feeAmount).toFixed(2)) * 10 ** tokenConfig.decimals);

  const transaction = new Transaction().add(
    createTransferCheckedInstruction(
      payerTokenAccount,
      tokenMint,
      merchantTokenAccount,
      payer,
      merchantAmountUnits,
      tokenConfig.decimals,
      [],
      TOKEN_PROGRAM_ID
    ),
    createTransferCheckedInstruction(
      payerTokenAccount,
      tokenMint,
      feeTokenAccount,
      payer,
      feeAmountUnits,
      tokenConfig.decimals,
      [],
      TOKEN_PROGRAM_ID
    )
  );

  const { blockhash } = await service.connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = payer;
  appendReference(transaction, reference);

  return transaction;
}

export async function precheckPayment(service, payerAddress, merchantAddress, merchantAmount, feeAmount, token = 'USDC') {
  try {
    const tokenConfig = config.tokens[token];
    if (!tokenConfig) {
      return { ok: false, errorKey: 'transaction_failed_retry', error: `Token ${token} not supported` };
    }

    const payer = new PublicKey(payerAddress);
    const merchant = new PublicKey(merchantAddress);
    const feeWallet = new PublicKey(config.cryptonow.feeWallet);
    const tokenMint = new PublicKey(tokenConfig.mint);

    const [payerTokenAccount, merchantTokenAccount, feeTokenAccount] = await Promise.all([
      service.getExistingTokenAccount(payer, tokenMint),
      service.getExistingTokenAccount(merchant, tokenMint),
      service.getExistingTokenAccount(feeWallet, tokenMint)
    ]);

    if (!merchantTokenAccount) {
      return { ok: false, errorKey: 'invalid_recipient_wallet', error: 'Recipient wallet is invalid for this payment' };
    }

    if (!feeTokenAccount) {
      return { ok: false, errorKey: 'transaction_failed_retry', error: 'Service fee wallet token account is missing' };
    }

    if (!payerTokenAccount) {
      return { ok: false, errorKey: 'insufficient_funds', error: 'Payer token account is missing' };
    }

    const [payerTokenBalance, payerLamports] = await Promise.all([
      service.connection.getTokenAccountBalance(payerTokenAccount),
      service.connection.getBalance(payer, 'processed')
    ]);

    const requiredUnits =
      toBaseUnits(Number(Number(merchantAmount).toFixed(2)).toFixed(2), tokenConfig.decimals) +
      toBaseUnits(Number(Number(feeAmount).toFixed(2)).toFixed(2), tokenConfig.decimals);
    const payerUnits = BigInt(String(payerTokenBalance?.value?.amount ?? '0'));

    if (payerUnits < requiredUnits) {
      return { ok: false, errorKey: 'insufficient_funds', error: 'Insufficient token balance' };
    }

    if (payerLamports < 10000) {
      return { ok: false, errorKey: 'insufficient_funds', error: 'Insufficient SOL for network fee' };
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      errorKey: 'transaction_failed_retry',
      error: error?.message || 'Precheck failed'
    };
  }
}

export async function simulateTransaction(service, transaction) {
  try {
    if (!transaction?.feePayer) {
      return { ok: false, error: 'Missing fee payer' };
    }
    if (!transaction.signatures || transaction.signatures.length === 0) {
      transaction.signatures = [{ publicKey: transaction.feePayer, signature: null }];
    }
    const result = await service.connection.simulateTransaction(transaction, undefined, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'processed'
    });
    if (result.value?.err) {
      return { ok: false, error: result.value.err, logs: result.value.logs || [] };
    }
    return { ok: true, logs: result.value?.logs || [] };
  } catch (error) {
    return { ok: false, error: error?.message || 'Simulation failed', logs: [] };
  }
}

export async function verifyTransaction(service, txSignature, expectedRecipient, expectedAmount, options = {}) {
  try {
    if (!config.helius.apiKey) {
      return { verified: false, error: 'Helius API key not configured' };
    }

    const { minBlockTime, maxBlockTime, commitment = 'finalized' } = options;
    const retryDelays = Array.isArray(options.retryDelays) && options.retryDelays.length > 0
      ? options.retryDelays
      : [2000, 2000, 2000, 5000, 10000, 30000, 60000];

    let txInfo = null;
    for (let attempt = 1; attempt <= retryDelays.length; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt - 1]));
      txInfo = await service.connection.getTransaction(txSignature, {
        commitment,
        maxSupportedTransactionVersion: 0
      });

      if (txInfo) break;
    }

    if (!txInfo) {
      return { verified: false, error: 'Transaction not found in blockchain' };
    }

    if (txInfo.meta?.err) {
      return { verified: false, error: 'Transaction failed on blockchain' };
    }

    const blockTime = txInfo.blockTime;
    if ((minBlockTime || maxBlockTime) && !blockTime) {
      return { verified: false, error: 'Transaction block time missing' };
    }
    if (minBlockTime && blockTime < minBlockTime) {
      return { verified: false, error: 'Transaction timestamp out of range' };
    }
    if (maxBlockTime && blockTime > maxBlockTime) {
      return { verified: false, error: 'Transaction timestamp out of range' };
    }

    const preBalances = txInfo.meta?.preTokenBalances || [];
    const postBalances = txInfo.meta?.postTokenBalances || [];
    const usdcMint = config.tokens.USDC.mint;
    const expectedOwner = String(expectedRecipient || '').toLowerCase();
    const expectedUnits = toBaseUnits(String(expectedAmount), config.tokens.USDC.decimals);

    let matchedChange = null;
    for (const post of postBalances) {
      if (String(post?.mint || '') !== usdcMint) continue;
      if (String(post?.owner || '').toLowerCase() !== expectedOwner) continue;

      const pre = preBalances.find((entry) =>
        entry?.accountIndex === post?.accountIndex && String(entry?.mint || '') === usdcMint
      );

      const preAmount = BigInt(String(pre?.uiTokenAmount?.amount ?? pre?.uiTokenAmount?.uiAmountString ?? '0'));
      const postAmount = BigInt(String(post?.uiTokenAmount?.amount ?? post?.uiTokenAmount?.uiAmountString ?? '0'));
      matchedChange = postAmount - preAmount;
      break;
    }

    if (matchedChange === null) {
      return { verified: false, error: 'Expected recipient transfer not found' };
    }

    if (matchedChange !== expectedUnits) {
      return { verified: false, error: 'Received amount does not match expected amount' };
    }

    const payer = txInfo.transaction?.message?.accountKeys?.[0]?.toBase58?.() || null;

    return {
      verified: true,
      details: {
        payer,
        blockTime,
        slot: txInfo.slot
      }
    };
  } catch (error) {
    return {
      verified: false,
      error: error?.message || 'Verification failed'
    };
  }
}

export async function findTransactionByReference(service, reference, options = {}) {
  return service.connection.getSignaturesForAddress(new PublicKey(reference), options);
}
