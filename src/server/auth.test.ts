import { describe, it, expect } from "vitest";
import { validateContentType, validateFileSize } from "./auth";

describe("validateContentType", () => {
  it("allows everything when no list is provided", () => {
    expect(validateContentType("audio/mpeg")).toBe(true);
    expect(validateContentType("anything/at-all", [])).toBe(true);
  });

  it("matches exact MIME types", () => {
    expect(validateContentType("audio/mpeg", ["audio/mpeg"])).toBe(true);
    expect(validateContentType("audio/wav", ["audio/mpeg"])).toBe(false);
  });

  it("supports wildcard families", () => {
    expect(validateContentType("image/png", ["image/*"])).toBe(true);
    expect(validateContentType("image/jpeg", ["image/*"])).toBe(true);
    expect(validateContentType("audio/mpeg", ["image/*"])).toBe(false);
  });
});

describe("validateFileSize", () => {
  it("allows any size when max is unset", () => {
    expect(validateFileSize(1_000_000_000)).toBe(true);
  });

  it("rejects files above the configured max", () => {
    expect(validateFileSize(100, 1000)).toBe(true);
    expect(validateFileSize(1000, 1000)).toBe(true);
    expect(validateFileSize(1001, 1000)).toBe(false);
  });
});
