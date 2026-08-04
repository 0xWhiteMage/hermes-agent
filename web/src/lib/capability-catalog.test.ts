import { describe, expect, it } from "vitest";

import type { CapabilityToolkit } from "./api";
import {
  FALLBACK_TOOLKIT_BRAND,
  mergeCapabilityToolkit,
} from "./capability-catalog";

describe("mergeCapabilityToolkit", () => {
  it("uses local presentation data while preferring the server description", () => {
    const serverDescription =
      "Send, receive, and organize email using your Gmail account.";
    const toolkit: CapabilityToolkit = {
      slug: "gmail",
      name: "Gmail",
      enabled: true,
      connected: true,
      logo: "https://example.com/gmail.svg",
      description: serverDescription,
      category: "email",
    };

    const result = mergeCapabilityToolkit(toolkit);

    expect(result.brand).toBe("#EA4335");
    expect(result.category).toBe("Communication");
    expect(result.description).toBe(serverDescription);
    expect(result.description).not.toBe("Send & manage email.");
  });

  it("uses server metadata and the fallback brand for an unmatched slug", () => {
    const toolkit: CapabilityToolkit = {
      slug: "posthog",
      name: "PostHog",
      enabled: false,
      connected: false,
      logo: "https://example.com/posthog.svg",
      category: "Analytics",
      description: "Product analytics.",
    };

    const result = mergeCapabilityToolkit(toolkit);

    expect(result.category).toBe("Analytics");
    expect(result.description).toBe("Product analytics.");
    expect(result.brand).toBe(FALLBACK_TOOLKIT_BRAND);
  });

  it("uses empty metadata fallbacks for an unmatched slug", () => {
    const toolkit: CapabilityToolkit = {
      slug: "posthog",
      name: "PostHog",
      enabled: false,
      connected: false,
      logo: "https://example.com/posthog.svg",
    };

    const result = mergeCapabilityToolkit(toolkit);

    expect(result.category).toBe("Other");
    expect(result.description).toBe("");
    expect(result.brand).toBe(FALLBACK_TOOLKIT_BRAND);
  });
});
