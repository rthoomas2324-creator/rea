import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Assistant, TOOLS } from "../src/agent.js";
import { Books } from "../src/store.js";

// A stand-in for the Anthropic client that replays scripted responses and
// records each request, so the tool loop can be tested without the network.
function scriptedClient(responses) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        async create(params) {
          requests.push(structuredClone(params));
          const next = responses.shift();
          if (!next) throw new Error("no scripted response left");
          return next;
        },
      },
    },
  };
}

async function freshBooks() {
  const dir = await mkdtemp(path.join(tmpdir(), "books-"));
  return Books.open(path.join(dir, "books.json"));
}

test("assistant records a transaction through a tool call and answers", async () => {
  const books = await freshBooks();
  const client = scriptedClient([
    {
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "", signature: "sig" },
        {
          type: "tool_use",
          id: "t1",
          name: "add_transaction",
          input: {
            type: "expense",
            amount: 45,
            date: "2026-10-01",
            category: "Office supplies",
            description: "Printer ink",
          },
        },
      ],
    },
    {
      stop_reason: "end_turn",
      content: [
        { type: "text", text: "Saved: $45.00 Office supplies on Oct 1." },
      ],
    },
  ]);
  const assistant = new Assistant(books, { client });
  const result = await assistant.chat(
    null,
    "paid $45 for printer ink on oct 1",
  );

  assert.equal(result.reply, "Saved: $45.00 Office supplies on Oct 1.");
  assert.equal(result.changed, true);
  assert.equal(books.listTransactions()[0].amount, 4500);
  assert.equal(books.listTransactions()[0].source, "assistant");

  const [first, second] = client.requests;
  assert.equal(first.model, "claude-opus-5-5");
  assert.deepEqual(first.tools, TOOLS);
  // The assistant turn goes back unchanged, thinking block included.
  assert.equal(second.messages[1].content[0].type, "thinking");
  assert.equal(second.messages[2].content[0].tool_use_id, "t1");

  // A follow-up continues the same conversation.
  client.requests.length = 0;
  client.beta.messages.create = async (params) => {
    client.requests.push(structuredClone(params));
    return {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "You spent $45." }],
    };
  };
  const followUp = await assistant.chat(
    result.conversationId,
    "how much did I spend?",
  );
  assert.equal(followUp.conversationId, result.conversationId);
  assert.equal(client.requests[0].messages.length, 5);
});

test("tool validation errors go back to Claude instead of failing the request", async () => {
  const books = await freshBooks();
  const client = scriptedClient([
    {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "mark_invoice_paid",
          input: { invoice: "9999" },
        },
      ],
    },
    {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "I couldn't find invoice 9999." }],
    },
  ]);
  const result = await new Assistant(books, { client }).chat(
    null,
    "invoice 9999 got paid",
  );
  const toolResult = client.requests[1].messages[2].content[0];
  assert.equal(toolResult.is_error, true);
  assert.match(toolResult.content, /No invoice/);
  assert.equal(result.changed, false);
});

test("a refusal does not keep the refused turn in history", async () => {
  const books = await freshBooks();
  const client = scriptedClient([{ stop_reason: "refusal", content: [] }]);
  const assistant = new Assistant(books, { client });
  const result = await assistant.chat(null, "something odd");
  assert.match(result.reply, /can't help/);
  assert.deepEqual(assistant.conversations.get(result.conversationId), []);
});

test("money in tool results is shown in dollars", async () => {
  const books = await freshBooks();
  await books.addTransaction({
    type: "income",
    amount: 19.99,
    description: "Sale",
  });
  const client = scriptedClient([
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t1", name: "get_summary", input: {} }],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] },
  ]);
  await new Assistant(books, { client }).chat(null, "summary");
  const summary = JSON.parse(client.requests[1].messages[2].content[0].content);
  assert.equal(summary.totalIncome, 19.99);
});
