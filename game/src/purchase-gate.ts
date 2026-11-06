// Who may start a paid-skin purchase. Web: Convex OAuth required (guests get a sign-in prompt).
// Wavedash: host login/paid flow decides — never Convex OAuth there.
export type PurchaseGate = "ok" | "signin";

export function purchaseGate(platformId: string, signedIn: boolean): PurchaseGate {
  if (platformId === "wavedash") return "ok";
  return signedIn ? "ok" : "signin";
}
