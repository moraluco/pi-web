import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MessageView } = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

function renderMessage(message) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, { message }),
    ),
  );
}

test("renders a provider error when the assistant message has no content", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [],
    stopReason: "error",
    errorMessage: "OpenAI API error (403): <html>request forbidden</html>",
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /Error: OpenAI API error \(403\)/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
});

test("renders partial assistant content before the provider error", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Partial response" }],
    stopReason: "error",
    errorMessage: "Connection closed",
  });

  assert.match(html, /Partial response/);
  assert.match(html, /Error: Connection closed/);
});

test("getToolPreview summarizes ask_user questions instead of [object Object]", async () => {
  const { getToolPreview } = await jiti.import("./MessageView.tsx");
  const preview = getToolPreview({
    toolName: "ask_user",
    input: {
      title: "旅行计划",
      questions: [
        { id: "q1", label: "目的地", prompt: "?", options: [] },
        { id: "q2", label: "装备", prompt: "?", options: [] },
      ],
    },
  });
  assert.equal(preview, "旅行计划 · 目的地 / 装备");
});

test("getToolPreview falls back to Qn labels and caps long lists", async () => {
  const { getToolPreview } = await jiti.import("./MessageView.tsx");
  const preview = getToolPreview({
    toolName: "ask_user",
    input: {
      questions: [
        { prompt: "?" }, { label: "B" }, { label: "C" }, { label: "D" }, { label: "E" },
      ],
    },
  });
  assert.equal(preview, "Q1 / B / C / D +1");
});

test("getToolPreview keeps existing behavior for other tools", async () => {
  const { getToolPreview } = await jiti.import("./MessageView.tsx");
  assert.equal(getToolPreview({ toolName: "bash", input: { command: "ls -la" } }), "ls -la");
  assert.equal(
    getToolPreview({ toolName: "write", input: { path: "/tmp/x", content: "y" } }),
    "/tmp/x",
  );
});
