/** Shared Dodo product map (live, $1.99 one-time). Keep in sync with docs/direction/iap-player-roster.md. */
export const PRODUCT_BY_SKU: Record<string, string> = {
  skin_fox: "pdt_0NrHHCiTcfac8OftVUWfQ",
  skin_cat: "pdt_0NrHHCmyNfPlsOiSLfDlh",
  skin_badger: "pdt_0NrHHCrUe0oyGUeqpDxIW",
  skin_possum: "pdt_0NrHHCvSBl0rcpKKmo1eB",
  skin_otter: "pdt_0NrHHCye7xJb9L0b68kl9",
};

export const SKU_RE = /^skin_[a-z]+$/;

export function skuFromProductId(productId: string | undefined | null): string | null {
  if (!productId) return null;
  for (const [sku, id] of Object.entries(PRODUCT_BY_SKU)) {
    if (id === productId) return sku;
  }
  return null;
}
