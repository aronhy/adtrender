import { describe, it, expect } from "vitest";
import { adContentState } from "./content";
describe("ad content availability", () => {
  it("ignores malformed provenance text safely", () =>
    expect(
      adContentState({
        mediaType: "TEXT",
        description: { invalid: true },
      } as any),
    ).toBe("missing"));

  it("renders a complete text creative without an image", () =>
    expect(
      adContentState({
        mediaType: "TEXT",
        headline: "Real headline",
        media: [],
      }),
    ).toBe("parsed"));
  it("treats a ready text screenshot as original preview", () =>
    expect(
      adContentState({
        mediaType: "TEXT",
        body: null,
        media: [{ type: "IMAGE", status: "READY" }],
      }),
    ).toBe("preview"));
  it("does not treat copy-only unknown or video records as confirmed text creatives", () => {
    expect(
      adContentState({
        mediaType: "UNKNOWN",
        body: "Available copy",
        media: [],
      }),
    ).toBe("missing");
    expect(
      adContentState({
        mediaType: "VIDEO",
        body: "Available copy",
        media: [{ type: "VIDEO", status: "FAILED" }],
      }),
    ).toBe("missing");
  });
  it("marks ready visual records with copy as parsed and keeps failed previews pending", () => {
    expect(
      adContentState({
        mediaType: "IMAGE",
        headline: "Real title",
        media: [{ type: "IMAGE", status: "READY" }],
      }),
    ).toBe("parsed");
    expect(
      adContentState({
        mediaType: "TEXT",
        media: [{ type: "IMAGE", status: "FAILED" }],
      }),
    ).toBe("missing");
  });
});
