// The bookkeeping assistant: Claude with a small set of tools over the books.
// It can read reports and records, and it can add customers, transactions and
// invoices. Every write goes through the same validation as the web forms.
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { NotFoundError, ValidationError } from "./store.js";

export const MODEL = process.env.BOOKKEEPING_MODEL || "claude-opus-5-5";
const MAX_TOOL_ROUNDS = 12;
const MAX_CONVERSATIONS = 200;

const dollars = (cents) => Math.round(cents) / 100;

// Tool results speak dollars, like the owner does; the store keeps cents.
function money(value) {
  if (Array.isArray(value)) return value.map(money);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (["createdAt", "updatedAt", "source"].includes(key)) continue;
    out[key] =
      typeof v === "number" &&
      /^(amount|total|unitPrice|balanceDue|income|expenses|net|totalIncome|totalExpenses|netProfit|outstandingAmount|overdueAmount)$/.test(
        key,
      )
        ? dollars(v)
        : money(v);
  }
  return out;
}

const dateField = { type: "string", description: "Date as YYYY-MM-DD" };

export const TOOLS = [
  {
    name: "get_summary",
    description:
      "Headline numbers for a period: total income, expenses, net profit, top expense categories, and open and overdue invoices. Omit dates for all time.",
    input_schema: {
      type: "object",
      properties: { from: dateField, to: dateField },
      additionalProperties: false,
    },
  },
  {
    name: "profit_and_loss",
    description:
      "Profit and loss report for a date range, broken down by income and expense category.",
    input_schema: {
      type: "object",
      properties: { from: dateField, to: dateField },
      additionalProperties: false,
    },
  },
  {
    name: "monthly_trend",
    description:
      "Income and expenses per month for the last N months (default 6), oldest first.",
    input_schema: {
      type: "object",
      properties: { months: { type: "integer", minimum: 1, maximum: 36 } },
      additionalProperties: false,
    },
  },
  {
    name: "list_transactions",
    description: "Find transactions, newest first. All filters are optional.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["income", "expense"] },
        category: { type: "string" },
        from: dateField,
        to: dateField,
        search: {
          type: "string",
          description: "Text to match in the description or category",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Defaults to 50",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "add_transaction",
    description:
      "Record one income or expense. Use an existing category from the books when one fits; a new name creates a new category. Amount is in the business currency, as a positive number.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["income", "expense"] },
        amount: { type: "number", exclusiveMinimum: 0 },
        date: dateField,
        category: { type: "string" },
        description: { type: "string" },
        customer_id: {
          type: "string",
          description: "Optional customer this income or expense relates to",
        },
      },
      required: ["type", "amount", "date", "category", "description"],
      additionalProperties: false,
    },
  },
  {
    name: "update_transaction",
    description:
      "Correct a transaction by id. Only the fields given are changed.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        type: { type: "string", enum: ["income", "expense"] },
        amount: { type: "number", exclusiveMinimum: 0 },
        date: dateField,
        category: { type: "string" },
        description: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_customers",
    description:
      "List customers with what each currently owes on open invoices.",
    input_schema: {
      type: "object",
      properties: { search: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "add_customer",
    description:
      "Add a customer. Check list_customers first so you don't create a duplicate.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        address: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "list_invoices",
    description:
      "List invoices, newest first, with totals and whether each is overdue.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["draft", "sent", "paid", "void"] },
        customer_id: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_invoice",
    description:
      "Create an invoice for an existing customer. Due date defaults to 30 days after the issue date. Prices are per unit in the business currency.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        issue_date: dateField,
        due_date: dateField,
        items: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              quantity: { type: "number", exclusiveMinimum: 0 },
              unit_price: { type: "number", minimum: 0 },
            },
            required: ["description", "quantity", "unit_price"],
            additionalProperties: false,
          },
        },
        notes: { type: "string" },
        status: {
          type: "string",
          enum: ["draft", "sent"],
          description: "Defaults to sent",
        },
      },
      required: ["customer_id", "items"],
      additionalProperties: false,
    },
  },
  {
    name: "mark_invoice_paid",
    description:
      "Record full payment of an invoice (by id or invoice number). This also books the income.",
    input_schema: {
      type: "object",
      properties: {
        invoice: { type: "string", description: "Invoice id or number" },
        paid_date: dateField,
      },
      required: ["invoice"],
      additionalProperties: false,
    },
  },
];

const WRITE_TOOLS = new Set([
  "add_transaction",
  "update_transaction",
  "add_customer",
  "create_invoice",
  "mark_invoice_paid",
]);

// Runs one tool call against the books. Returns the JSON-able result.
export async function runTool(books, name, input) {
  switch (name) {
    case "get_summary":
      return money(books.summary(input));
    case "profit_and_loss":
      return money(books.profitAndLoss(input));
    case "monthly_trend":
      return money(books.monthlyTrend(input.months ?? 6));
    case "list_transactions": {
      const rows = books.listTransactions({ ...input, limit: undefined });
      const limit = input.limit ?? 50;
      return {
        total_matches: rows.length,
        showing: Math.min(limit, rows.length),
        transactions: money(rows.slice(0, limit)),
      };
    }
    case "add_transaction":
      return money(
        await books.addTransaction(
          { ...input, customerId: input.customer_id },
          { source: "assistant" },
        ),
      );
    case "update_transaction": {
      const { id, ...changes } = input;
      return money(await books.updateTransaction(id, changes));
    }
    case "list_customers":
      return money(books.listCustomers(input));
    case "add_customer":
      return money(await books.addCustomer(input));
    case "list_invoices":
      return money(
        books.listInvoices({
          status: input.status,
          customerId: input.customer_id,
        }),
      );
    case "create_invoice":
      return money(
        await books.createInvoice({
          customerId: input.customer_id,
          issueDate: input.issue_date,
          dueDate: input.due_date,
          notes: input.notes,
          status: input.status,
          items: input.items.map((i) => ({
            description: i.description,
            quantity: i.quantity,
            unitPrice: i.unit_price,
          })),
        }),
      );
    case "mark_invoice_paid":
      return money(
        await books.markInvoicePaid(input.invoice, {
          paidDate: input.paid_date,
        }),
      );
    default:
      throw new ValidationError(`Unknown tool ${name}`);
  }
}

function systemPrompt(books) {
  const { businessName, currency, categories } = books.getSettings();
  return `You are the bookkeeping assistant for ${businessName}, a small business. You help the owner understand their books and keep them up to date. The owner is usually not an accountant, so use plain language and short answers.

Today is ${new Date().toISOString().slice(0, 10)}. Amounts are in ${currency}.
Income categories: ${categories.income.join(", ")}.
Expense categories: ${categories.expense.join(", ")}.

How to work:
- Answer questions from the tools, not from memory. Quote real numbers and say which period they cover.
- When the owner describes money coming in or going out, record it with add_transaction. Pick the closest existing category. If the date isn't given, use today. If the amount or whether it is income or an expense is unclear, ask instead of guessing.
- Before creating an invoice, find the customer with list_customers; add them only if they don't exist.
- After recording something, confirm in one line what you saved (date, amount, category) so the owner can spot mistakes.
- You are not a tax advisor. For tax or legal questions, give general information and suggest checking with an accountant.`;
}

// Conversation state lives on the server so the full assistant content,
// including thinking blocks, goes back to the API unchanged on every turn.
export class Assistant {
  constructor(books, { client } = {}) {
    this.books = books;
    this.client = client ?? null;
    this.conversations = new Map();
  }

  get configured() {
    return Boolean(
      this.client ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN,
    );
  }

  getClient() {
    this.client ??= new Anthropic();
    return this.client;
  }

  // Sends one owner message and runs tool calls until Claude answers.
  // Returns { conversationId, reply, actions, changed }.
  async chat(conversationId, text) {
    const message = typeof text === "string" ? text.trim() : "";
    if (!message) throw new ValidationError("Message is required");
    if (message.length > 8000) throw new ValidationError("Message is too long");

    let id =
      conversationId && this.conversations.has(conversationId)
        ? conversationId
        : randomUUID();
    const history = this.conversations.get(id) ?? [];
    const pending = [...history, { role: "user", content: message }];
    const actions = [];
    const client = this.getClient();

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium" },
        system: systemPrompt(this.books),
        tools: TOOLS,
        messages: pending,
      });
      pending.push({ role: "assistant", content: response.content });

      if (response.stop_reason === "refusal") {
        return this.finish(
          id,
          history,
          actions,
          "Sorry, I can't help with that request.",
        );
      }
      if (response.stop_reason !== "tool_use") {
        const reply = response.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        this.remember(id, pending);
        return this.finish(id, pending, actions, reply || "(No answer.)");
      }

      const results = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        try {
          const output = await runTool(
            this.books,
            block.name,
            block.input ?? {},
          );
          if (WRITE_TOOLS.has(block.name))
            actions.push({ tool: block.name, input: block.input });
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(output),
          });
        } catch (error) {
          if (
            !(
              error instanceof ValidationError || error instanceof NotFoundError
            )
          )
            throw error;
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: error.message,
            is_error: true,
          });
        }
      }
      pending.push({ role: "user", content: results });
    }

    // Too many rounds: keep the books changes but don't keep a half-finished turn.
    return this.finish(
      id,
      history,
      actions,
      "That took more steps than I expected. Could you break it into smaller requests?",
    );
  }

  remember(id, messages) {
    this.conversations.delete(id);
    this.conversations.set(id, messages);
    while (this.conversations.size > MAX_CONVERSATIONS) {
      this.conversations.delete(this.conversations.keys().next().value);
    }
  }

  finish(id, messages, actions, reply) {
    if (!this.conversations.has(id)) this.remember(id, messages);
    return { conversationId: id, reply, actions, changed: actions.length > 0 };
  }

  reset(conversationId) {
    this.conversations.delete(conversationId);
  }
}

export function describeApiError(error) {
  if (error instanceof Anthropic.AuthenticationError)
    return "The assistant's API key was rejected. Check ANTHROPIC_API_KEY.";
  if (error instanceof Anthropic.RateLimitError)
    return "The assistant is busy right now. Try again in a minute.";
  if (error instanceof Anthropic.APIConnectionError)
    return "Couldn't reach the assistant. Check your internet connection.";
  if (error instanceof Anthropic.APIError)
    return `The assistant hit an error (${error.status ?? "unknown"}). Try again.`;
  return null;
}
