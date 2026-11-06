import { describe, expect, it } from "vitest";
import { SIGN_IN_TO_UNLOCK_SKINS, customiseCtaState } from "../src/customise-cta";

const paid = { priceUsd: 1.99 };

describe("customiseCtaState", () => {
  it("web guest sees disabled Sign in to unlock skins", () => {
    const cta = customiseCtaState(paid, {
      owned: false,
      selected: false,
      needsSignIn: true,
      loading: false,
      busy: false,
    });
    expect(cta).toEqual({
      label: SIGN_IN_TO_UNLOCK_SKINS,
      mode: "signin",
      disabled: true,
      locked: true,
    });
    expect(cta.label).toBe("Sign in to unlock skins");
  });

  it("signed-in unpaid skin shows Unlock $price and stays enabled", () => {
    const cta = customiseCtaState(paid, {
      owned: false,
      selected: false,
      needsSignIn: false,
      loading: false,
      busy: false,
    });
    expect(cta).toEqual({
      label: "Unlock $1.99",
      mode: "buy",
      disabled: false,
      locked: true,
    });
  });

  it("owned skins stay Select / Selected (Wavedash + web)", () => {
    expect(
      customiseCtaState(paid, {
        owned: true,
        selected: false,
        needsSignIn: false,
        loading: false,
        busy: false,
      }).mode,
    ).toBe("select");
    expect(
      customiseCtaState(paid, {
        owned: true,
        selected: true,
        needsSignIn: true, // gate irrelevant when owned
        loading: false,
        busy: false,
      }),
    ).toMatchObject({ label: "Selected", mode: "selected", locked: false });
  });

  it("loading overrides guest/buy labels and disables", () => {
    expect(
      customiseCtaState(paid, {
        owned: false,
        selected: false,
        needsSignIn: true,
        loading: true,
        busy: false,
        loadingLabel: "Fetching Scrap Fox…",
      }),
    ).toEqual({
      label: "Fetching Scrap Fox…",
      mode: "loading",
      disabled: true,
      locked: true,
    });
  });
});
