// DOM globals for the /react entry under bun:test, which has no jsdom
// environment. Load it before React Testing Library, e.g. in bunfig.toml:
//
//   [test]
//   preload = ["feather-testing-postgres/happy-dom"]
//
// or as the first import of a component test file. Vitest keeps using its own
// `environment: 'jsdom'` (or 'happy-dom'); there this module is a no-op.

import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof document === 'undefined') {
  // Keep the runtime's own networking: happy-dom's fetch/Request/Response
  // would replace Bun's, which servers and drivers in the same test rely on.
  const keep = ['fetch', 'Request', 'Response', 'Headers', 'FormData', 'Blob', 'File', 'URL', 'URLSearchParams', 'AbortController', 'AbortSignal', 'ReadableStream', 'WebSocket'] as const
  const saved = Object.fromEntries(keep.map((k) => [k, (globalThis as any)[k]]))
  GlobalRegistrator.register({ url: 'http://localhost/' })
  for (const k of keep) if (saved[k]) (globalThis as any)[k] = saved[k]
}
