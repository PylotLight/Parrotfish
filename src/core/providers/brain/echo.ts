import type { BrainProvider, ProviderFactory } from "../types";
import { throwIfAborted } from "../types";

/** Explicit loopback, not a mock or a language model: speak exactly the last transcript. */
export const echoBrain: ProviderFactory<BrainProvider> = () => ({
  id: "echo",
  async *stream(messages, { signal }) {
    throwIfAborted(signal);
    const user = messages.findLast((message) => message.role === "user");
    if (user?.content.trim()) yield user.content.trim();
  },
});
