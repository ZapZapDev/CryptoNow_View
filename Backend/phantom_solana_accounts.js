import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';

const TOKENS = {
  USDC: {
    mint: process.env.USDC_MINT
  }
};

export function validateAddress(_service, address) {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

export async function getExistingTokenAccount(service, owner, mint) {
  const ata = await getAssociatedTokenAddress(mint, owner);
  const info = await service.connection.getAccountInfo(ata);
  return info ? ata : null;
}

export async function ensureAtaForOwner(service, ownerAddress, token = 'USDC') {
  const tokenConfig = TOKENS[token];
  if (!tokenConfig?.mint) return null;
  const owner = new PublicKey(ownerAddress);
  const mint = new PublicKey(tokenConfig.mint);
  return getExistingTokenAccount(service, owner, mint);
}
