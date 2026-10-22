// "No router": every turn goes to the brain. The control for router A/B runs.
import type { ProviderFactory, RouterProvider } from "../types";

export const alwaysReply: ProviderFactory<RouterProvider> = () => ({
  id: "none",
  async decide() {
    return {
      choice: "reply_local",
      probabilities: { reply_local: 1 },
      confidence: 1,
    };
  },
});
