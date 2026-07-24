// ─── Global Mocks for Workers Runtime APIs ─────────────
// Vitest runs in Node.js, but the codebase uses Workers
// runtime APIs. We mock only what's needed for tests.

import { vi } from "vitest";
import { TextEncoder, TextDecoder } from "node:util";

// Web Crypto API is available in Node 20+, but getRandomValues
// may need a polyfill for uid() deterministic testing
if (typeof globalThis.crypto === "undefined") {
  globalThis.crypto = {};
}
if (!globalThis.crypto.getRandomValues) {
  globalThis.crypto.getRandomValues = (buf) => {
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 17 + 42) & 0xff;
    return buf;
  };
}

// TextEncoder / TextDecoder (Node 20+ provides these)
if (typeof globalThis.TextEncoder === "undefined") {
  globalThis.TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === "undefined") {
  globalThis.TextDecoder = TextDecoder;
}

// TransformStream (not available in Node <21)
// Needed only for pipeStream tests, not for pure translation tests
if (typeof globalThis.TransformStream === "undefined") {
  class SimpleTransformStream {
    constructor() {
      const { readable, writable } = new SimpleStreamPair();
      this.readable = readable;
      this.writable = writable;
    }
  }
  class SimpleStreamPair {
    constructor() {
      this._readableController = null;
      this.readable = new ReadableStream({
        start: (c) => { this._readableController = c; },
      });
      this.writable = new WritableStream({
        write: (chunk) => {
          if (this._readableController) {
            this._readableController.enqueue(chunk);
          }
        },
        close: () => {
          if (this._readableController) this._readableController.close();
        },
      });
    }
  }
  globalThis.TransformStream = SimpleTransformStream;
}
