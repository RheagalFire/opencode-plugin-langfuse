import type { Plugin } from "@opencode-ai/plugin";
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
export declare const LangfusePlugin: Plugin;
//# sourceMappingURL=index.d.ts.map