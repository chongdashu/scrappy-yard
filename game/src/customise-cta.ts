// Pure label/disabled state for the Customise CTA — kept free of DOM so tests can cover guest lock.
import type { Skin } from "./skins";

export type CustomiseCtaMode = "loading" | "selected" | "select" | "signin" | "buy";

export type CustomiseCtaState = {
  label: string;
  mode: CustomiseCtaMode;
  disabled: boolean;
  locked: boolean;
};

/** Guest unlock copy — shown on the disabled CTA itself (not a post-click banner). */
export const SIGN_IN_TO_UNLOCK_SKINS = "Sign in to unlock skins";

export function customiseCtaState(
  skin: Pick<Skin, "priceUsd">,
  opts: {
    owned: boolean;
    selected: boolean;
    needsSignIn: boolean;
    loading: boolean;
    busy: boolean;
    loadingLabel?: string;
  },
): CustomiseCtaState {
  if (opts.loading) {
    return {
      label: opts.loadingLabel || "Loading…",
      mode: "loading",
      disabled: true,
      locked: !opts.owned,
    };
  }
  if (opts.owned) {
    if (opts.selected) {
      return { label: "Selected", mode: "selected", disabled: opts.busy, locked: false };
    }
    return { label: "Select", mode: "select", disabled: opts.busy, locked: false };
  }
  if (opts.needsSignIn) {
    return {
      label: SIGN_IN_TO_UNLOCK_SKINS,
      mode: "signin",
      disabled: true,
      locked: true,
    };
  }
  return {
    label: `Unlock $${skin.priceUsd.toFixed(2)}`,
    mode: "buy",
    disabled: opts.busy,
    locked: true,
  };
}
