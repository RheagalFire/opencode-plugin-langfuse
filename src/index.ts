import { LangfuseSpanProcessor } from "@langfuse/otel";
import type { Plugin } from "@opencode-ai/plugin";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { trace, context as otelContext, type Span } from "@opentelemetry/api";

/**
 * Langfuse plugin for OpenCode.
 *
 * Patched in this fork to nest each session-turn's LLM calls + tool spans
 * under a single OTel parent span, so Langfuse renders one trace per turn
 * instead of one trace per `ai.streamText` invocation.
 *
 * Nesting works by:
 *   1. Starting a root span on `chat.message` (per sessionID). Span name is
 *      configurable via `LANGFUSE_ROOT_SPAN_NAME` (default: `brainforge-work`)
 *      so the Langfuse trace title can match the host product brand.
 *   2. Using AsyncLocalStorage.enterWith() to install that span as the
 *      active OTel context for opencode's downstream async chain so
 *      every AI SDK + tool span emitted afterwards inherits it as parent.
 *   3. Ending the parent span on `session.idle`.
 */
export const LangfusePlugin: Plugin = async ({ client }) => {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASEURL ?? "https://cloud.langfuse.com";
  const environment = process.env.LANGFUSE_ENVIRONMENT ?? "development";
  const rootSpanName = process.env.LANGFUSE_ROOT_SPAN_NAME ?? "brainforge-work";

  const log = (level: "info" | "warn" | "error", message: string) => {
    client.app.log({
      body: { service: "langfuse-otel", level, message },
    });
  };

  if (!publicKey || !secretKey) {
    log(
      "warn",
      "Missing LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY - tracing disabled"
    );
    return {};
  }

  const processor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl,
    environment,
    // Override default filter: accept our session.turn parent + any LLM-related spans.
    // Without this, the default filter only passes spans with gen_ai.* attrs or from
    // known instrumentors and silently drops our manually-created parent span.
    shouldExportSpan: ({ otelSpan }) => {
      if (otelSpan.name === rootSpanName) return true;
      const attrs = otelSpan.attributes ?? {};
      for (const key of Object.keys(attrs)) {
        if (
          key.startsWith("gen_ai.") ||
          key.startsWith("ai.") ||
          key.startsWith("langfuse.")
        ) {
          return true;
        }
      }
      return false;
    },
  });

  const sdk = new NodeSDK({
    spanProcessors: [processor],
  });

  sdk.start();
  log("info", `OTEL tracing initialized → ${baseUrl}`);

  const tracer = trace.getTracer("opencode-plugin-langfuse");
  const sessionParents = new Map<string, Span>();

  // Reach into the AsyncLocalStorage backing the global ContextManager so we
  // can pin a parent context across opencode's async chain. NodeSDK installs
  // AsyncHooksContextManager by default; if a different manager is in use,
  // we silently skip the nesting (spans still emit, just unnested as before).
  const getAls = (): { enterWith: (store: unknown) => void } | undefined => {
    const ctxApi = otelContext as unknown as {
      _getContextManager?: () => unknown;
    };
    const cm = ctxApi._getContextManager?.() as
      | { _asyncLocalStorage?: { enterWith: (s: unknown) => void } }
      | undefined;
    return cm?._asyncLocalStorage;
  };

  const ensureParent = (sessionID: string): Span => {
    let span = sessionParents.get(sessionID);
    if (!span) {
      span = tracer.startSpan(rootSpanName, {
        attributes: { "session.id": sessionID },
      });
      sessionParents.set(sessionID, span);
    }
    return span;
  };

  const activateParent = (sessionID: string) => {
    const parent = ensureParent(sessionID);
    const newCtx = trace.setSpan(otelContext.active(), parent);
    const als = getAls();
    if (als) {
      als.enterWith(newCtx);
    }
  };

  const endParent = (sessionID: string) => {
    const span = sessionParents.get(sessionID);
    if (span) {
      span.end();
      sessionParents.delete(sessionID);
    }
  };

  // Extract concatenated text from a list of opencode `Part` objects.
  // Used for both user input (chat.message hook) and assistant output
  // (fetched via client.session.messages on session.idle).
  const extractText = (parts: unknown): string | undefined => {
    if (!Array.isArray(parts)) return undefined;
    const texts: string[] = [];
    for (const p of parts) {
      if (
        p &&
        typeof p === "object" &&
        (p as { type?: unknown }).type === "text" &&
        typeof (p as { text?: unknown }).text === "string"
      ) {
        texts.push((p as { text: string }).text);
      }
    }
    const joined = texts.join("\n").trim();
    return joined.length > 0 ? joined : undefined;
  };

  return {
    config: async (config) => {
      if (!config.experimental?.openTelemetry) {
        log(
          "warn",
          "OpenTelemetry experimental feature is disabled in Opencode config - tracing disabled"
        );
      }
    },
    "chat.message": async (input, output) => {
      // New user turn → ensure a parent span exists and is active in our context.
      activateParent(input.sessionID);
      // Capture the user's prompt as the trace input. Langfuse promotes this
      // span attribute to the trace-level input field in its UI.
      const userText = extractText(output?.parts);
      if (userText) {
        const parent = sessionParents.get(input.sessionID);
        parent?.setAttribute("langfuse.observation.input", userText);
      }
    },
    "chat.params": async (input) => {
      // Before each AI SDK call: pin parent context so streamText spans nest.
      activateParent(input.sessionID);
    },
    "tool.execute.before": async (input) => {
      // Tool calls run inside the AI SDK loop; re-pin to be safe.
      activateParent(input.sessionID);
    },
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        const sid = (event as { properties?: { sessionID?: string } })
          .properties?.sessionID;
        if (sid) {
          // Before ending the parent: fetch the latest assistant message text
          // and attach it as the trace output. Tolerate any failure here so we
          // never block the flush on transient SDK errors.
          try {
            const parent = sessionParents.get(sid);
            if (parent) {
              const res = await client.session.messages({ path: { id: sid } });
              const items = (res as { data?: Array<{ info: { role: string }; parts: unknown }> })
                .data;
              if (Array.isArray(items)) {
                for (let i = items.length - 1; i >= 0; i--) {
                  if (items[i]?.info?.role === "assistant") {
                    const text = extractText(items[i].parts);
                    if (text) {
                      parent.setAttribute("langfuse.observation.output", text);
                    }
                    break;
                  }
                }
              }
            }
          } catch (err) {
            log(
              "warn",
              `Failed to fetch session output for trace: ${(err as Error).message}`
            );
          }
          endParent(sid);
        }
        log("info", "Flushing OTEL spans before idle");
        await processor.forceFlush();
      }
      // Removed `server.instance.disposed → sdk.shutdown()` from upstream:
      // that handler fires on workspace dispose too, killing the SDK mid-process
      // and silently breaking all subsequent spans for unrelated workspaces.
    },
  };
};
