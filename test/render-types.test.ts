import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module without declarations
import { constName, renderTypes } from "../bin/render-types.mjs";

describe("latch-generate rendering", () => {
  it("names keys readably", () => {
    expect(constName("perks.hero-image")).toBe("PerksHeroImage");
    expect(constName("2fa.on")).toBe("Flag2faOn");
  });
  it("renders keys, kinds and value types in key order", () => {
    const text: string = renderTypes("demo", [
      { key: "plan.mode", kind: "string", values: [{ value: "locked" }, { value: "available" }] },
      { key: "checkout.new", kind: "boolean" },
    ]);
    expect(text).toContain('  CheckoutNew: "checkout.new",\n  PlanMode: "plan.mode",');
    expect(text).toContain('  "plan.mode": "available" | "locked";');
    expect(text).toContain('  "checkout.new": boolean;');
  });
  it("gives the same text for the same flags in any order", () => {
    const a = [{ key: "b", kind: "boolean" }, { key: "a", kind: "number" }];
    expect(renderTypes("p", a)).toBe(renderTypes("p", [...a].reverse()));
  });
  it("refuses two keys that would get the same name", () => {
    expect(() => renderTypes("p", [{ key: "a.b", kind: "boolean" }, { key: "a-b", kind: "boolean" }])).toThrow(/both become AB/);
  });
});
