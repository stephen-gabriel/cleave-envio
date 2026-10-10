// Freeze the committed public wallet list for a replay. Changing it requires reindexing.
export function walletClassifier(wallets: readonly string[]) {
  for (const address of wallets) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Invalid address in sim-wallets.json')
  }
  const addresses = new Set(wallets.map(address => address.toLowerCase()))
  return (address: string) => addresses.has(address.toLowerCase())
}