/// <reference types="vite/client" />
import type { ParrotfishApi } from "../../shared/api";

declare global {
  interface Window {
    parrotfish: ParrotfishApi;
  }
}
