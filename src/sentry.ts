// Sentry error reporting (oxjob #1685): errors only. No tracing, no breadcrumbs, no request or binding instrumentation.
//
// Same module as openalex-api-proxy src/sentry.ts. Why not Sentry's withSentry wrapper: it builds a new SDK client
// for every request and wraps env, ctx, KV and global fetch in proxies. Instead a client is built only when an
// error is reported: a request that doesn't fail pays one AsyncLocalStorage.run and nothing else.
//
// Inert unless the SENTRY_DSN Worker secret is set. Volume guards: each isolate sends at most
// MAX_EVENTS_PER_MINUTE events, callers sample known high-volume failures (sampleRate), and the Sentry project key
// has its own per-minute cap (Sentry drops events over it, unbilled).
import { AsyncLocalStorage } from "node:async_hooks";
import {
    CloudflareClient,
    Scope,
    createTransport,
    eventFiltersIntegration,
    linkedErrorsIntegration,
} from "@sentry/cloudflare";
import { basename, createStackParser, nodeStackLineParser, type StackLineParser } from "@sentry/core";

export interface SentryEnv {
    SENTRY_DSN?: string;          // Worker secret; unset = reporting off
    SENTRY_ENVIRONMENT?: string;  // default "production"
    CF_VERSION_METADATA?: { id: string };
}

export interface Invocation {
    env: SentryEnv;
    waitUntil: (p: Promise<unknown>) => void;
    request?: Request;
}

const invocation = new AsyncLocalStorage<Invocation>();

// The SDK's Workers stack parser (@sentry/cloudflare vendor/stacktrace.js, not exported): Workers frames have bare
// file names ("index.js:12:3"), so mark them in-app and give them a leading "/" as the SDK does.
function workersStackLineParser(): StackLineParser {
    const [priority, parse] = nodeStackLineParser((filename) => (filename ? basename(filename, ".js") : undefined));
    return [priority, (line) => {
        const frame = parse(line);
        if (frame) {
            const { filename } = frame;
            frame.abs_path = filename !== undefined && !filename.startsWith("/") ? `/${filename}` : filename;
            frame.in_app = filename !== undefined;
        }
        return frame;
    }];
}
const stackParser = createStackParser(workersStackLineParser());

/** "Name: message" for an Error, else the value as text (some runtime errors arrive with an empty message). */
export function errorText(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

const MAX_EVENTS_PER_MINUTE = 10;
let windowStartMs = 0;
let eventsInWindow = 0;

/** Runs fn with what reportError needs (env, waitUntil, the request); reports anything it throws, then rethrows. */
export function withErrorReporting<T>(inv: Invocation, site: string, fn: () => Promise<T>): Promise<T> {
    return invocation.run(inv, async () => {
        try {
            return await fn();
        } catch (error) {
            reportError(error, { site, handled: false });
            throw error;
        }
    });
}

export interface ReportOptions {
    site: string;                      // where it failed: a short stable name, sent as the `site` tag
    sampleRate?: number;               // 0..1 for known high-volume failures; default 1
    handled?: boolean;                 // false = escaped a handler (default true)
    extra?: Record<string, unknown>;
    inv?: Invocation;                  // for code outside withErrorReporting (e.g. a Durable Object constructor)
}

/** Sends one error to Sentry, never throws, never blocks: the send runs in waitUntil. */
export function reportError(error: unknown, opts: ReportOptions): void {
    try {
        const inv = opts.inv ?? invocation.getStore();
        const dsn = inv?.env.SENTRY_DSN;
        if (!inv || !dsn) return;
        const sampleRate = opts.sampleRate ?? 1;
        if (Math.random() >= sampleRate) return;
        const now = Date.now();
        if (now - windowStartMs >= 60_000) {
            windowStartMs = now;
            eventsInWindow = 0;
        }
        if (eventsInWindow >= MAX_EVENTS_PER_MINUTE) return;
        eventsInWindow++;

        const client = new CloudflareClient({
            dsn,
            environment: inv.env.SENTRY_ENVIRONMENT || "production",
            release: inv.env.CF_VERSION_METADATA?.id,
            sendDefaultPii: false,
            stackParser,
            integrations: [eventFiltersIntegration(), linkedErrorsIntegration()],
            transport: (options) => createTransport(options, async (request) => {
                const res = await fetch(options.url, { method: "POST", body: request.body, headers: options.headers });
                await res.body?.cancel();
                return {
                    statusCode: res.status,
                    headers: {
                        "x-sentry-rate-limits": res.headers.get("X-Sentry-Rate-Limits"),
                        "retry-after": res.headers.get("Retry-After"),
                    },
                };
            }),
        });
        client.init();

        const scope = new Scope();
        scope.setTag("site", opts.site);
        // Workers runtime errors carry no JS stack and read "internal error; reference = <id>", so Sentry's default
        // grouping (by message) would open a new issue for each one: group those by site and message minus the id.
        const text = errorText(error);
        if (/reference = \S+/.test(text)) scope.setFingerprint([opts.site, text.replace(/reference = \S+/g, "reference = <id>")]);
        if (sampleRate < 1) scope.setTag("sample_rate", String(sampleRate));
        const req = inv.request;
        if (req) {
            const url = new URL(req.url);
            scope.setTag("method", req.method);
            scope.setTag("host", url.host);
            scope.setExtra("path", url.pathname); // path only: query strings carry API keys and emails
            const colo = (req as { cf?: { colo?: unknown } }).cf?.colo;
            if (typeof colo === "string") scope.setTag("colo", colo);
        }
        // Some runtime errors arrive with an empty message (#1685: "Analytics write failed" logged only a stack).
        scope.setExtra("error_text", text);
        if (opts.extra) scope.setExtras(opts.extra);

        client.captureException(error, { mechanism: { type: "generic", handled: opts.handled ?? true } }, scope);
        const sent = client.flush(2000).catch(() => false);
        inv.waitUntil(sent);
    } catch {
        // Reporting must never break the request.
    }
}
