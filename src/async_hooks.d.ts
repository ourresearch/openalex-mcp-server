// The one Node API src/sentry.ts uses (nodejs_compat provides it at runtime); this repo doesn't load @types/node.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, fn: () => R): R;
  }
}
