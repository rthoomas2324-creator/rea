// HTTP server: a JSON API over the books, the assistant endpoint, and the web UI.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Assistant, describeApiError, MODEL } from "./agent.js";
import { Books, NotFoundError, ValidationError } from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "..", "public");
const MAX_BODY = 1_000_000;

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "Request is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error();
    return body;
  } catch {
    throw new HttpError(400, "Body must be a JSON object");
  }
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (status === 204) return res.end();
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

// Routes are [method, pattern, handler]; :id segments are passed as params.
function buildRoutes(books, assistant) {
  return [
    ["GET", "/api/settings", () => books.getSettings()],
    ["PUT", "/api/settings", (_, body) => books.updateSettings(body)],
    [
      "POST",
      "/api/categories",
      (_, body) => books.addCategory(body.type, body.name),
    ],

    ["GET", "/api/summary", (q) => books.summary(q)],
    ["GET", "/api/reports/profit-and-loss", (q) => books.profitAndLoss(q)],
    [
      "GET",
      "/api/reports/monthly",
      (q) =>
        books.monthlyTrend(Math.min(Math.max(Number(q.months) || 6, 1), 36)),
    ],

    ["GET", "/api/customers", (q) => books.listCustomers(q)],
    ["POST", "/api/customers", (_, body) => books.addCustomer(body)],
    [
      "PUT",
      "/api/customers/:id",
      (_, body, p) => books.updateCustomer(p.id, body),
    ],
    ["DELETE", "/api/customers/:id", (_, __, p) => books.deleteCustomer(p.id)],

    [
      "GET",
      "/api/transactions",
      (q) =>
        books.listTransactions({
          ...q,
          limit: q.limit ? Number(q.limit) : undefined,
        }),
    ],
    ["POST", "/api/transactions", (_, body) => books.addTransaction(body)],
    [
      "PUT",
      "/api/transactions/:id",
      (_, body, p) => books.updateTransaction(p.id, body),
    ],
    [
      "DELETE",
      "/api/transactions/:id",
      (_, __, p) => books.deleteTransaction(p.id),
    ],

    ["GET", "/api/invoices", (q) => books.listInvoices(q)],
    ["POST", "/api/invoices", (_, body) => books.createInvoice(body)],
    [
      "PUT",
      "/api/invoices/:id",
      (_, body, p) => books.updateInvoice(p.id, body),
    ],
    [
      "POST",
      "/api/invoices/:id/pay",
      (_, body, p) => books.markInvoicePaid(p.id, body),
    ],
    ["DELETE", "/api/invoices/:id", (_, __, p) => books.deleteInvoice(p.id)],

    [
      "GET",
      "/api/assistant",
      () => ({ configured: assistant.configured, model: MODEL }),
    ],
    [
      "POST",
      "/api/assistant",
      async (_, body) => {
        if (!assistant.configured) {
          throw new HttpError(
            503,
            "The assistant needs an Anthropic API key. Set ANTHROPIC_API_KEY and restart.",
          );
        }
        try {
          return await assistant.chat(body.conversationId, body.message);
        } catch (error) {
          const message = describeApiError(error);
          if (message) throw new HttpError(502, message);
          throw error;
        }
      },
    ],
  ];
}

function match(routes, method, pathname) {
  for (const [m, pattern, handler] of routes) {
    if (m !== method) continue;
    const a = pattern.split("/");
    const b = pathname.split("/");
    if (a.length !== b.length) continue;
    const params = {};
    if (
      a.every((seg, i) =>
        seg.startsWith(":")
          ? (params[seg.slice(1)] = decodeURIComponent(b[i]))
          : seg === b[i],
      )
    ) {
      return { handler, params };
    }
  }
  return null;
}

async function serveStatic(res, pathname) {
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolved = path.resolve(PUBLIC_DIR, file);
  const type = STATIC_TYPES[path.extname(resolved)];
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) || !type)
    return send(res, 404, { error: "Not found" });
  try {
    send(res, 200, await readFile(resolved), type);
  } catch {
    send(res, 404, { error: "Not found" });
  }
}

export function createApp(books, assistant = new Assistant(books)) {
  const routes = buildRoutes(books, assistant);
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (
        req.method === "GET" &&
        url.pathname === "/api/export/transactions.csv"
      ) {
        res.setHeader(
          "content-disposition",
          'attachment; filename="transactions.csv"',
        );
        return send(
          res,
          200,
          books.exportTransactionsCsv(Object.fromEntries(url.searchParams)),
          "text/csv; charset=utf-8",
        );
      }
      if (!url.pathname.startsWith("/api/")) {
        if (req.method !== "GET")
          return send(res, 405, { error: "Method not allowed" });
        return await serveStatic(res, url.pathname);
      }
      const found = match(routes, req.method, url.pathname);
      if (!found) return send(res, 404, { error: "Not found" });
      const body = ["POST", "PUT"].includes(req.method)
        ? await readJson(req)
        : {};
      const result = await found.handler(
        Object.fromEntries(url.searchParams),
        body,
        found.params,
      );
      send(res, result === undefined ? 204 : 200, result ?? "");
    } catch (error) {
      if (error instanceof ValidationError)
        return send(res, 400, { error: error.message });
      if (error instanceof NotFoundError)
        return send(res, 404, { error: error.message });
      if (error instanceof HttpError)
        return send(res, error.status, { error: error.message });
      console.error(error);
      send(res, 500, { error: "Something went wrong on the server" });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dataFile =
    process.env.BOOKS_FILE || path.join(here, "..", "data", "books.json");
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || "127.0.0.1";
  const books = await Books.open(dataFile);
  createApp(books).listen(port, host, () => {
    console.log(`Bookkeeping app running at http://${host}:${port}`);
    console.log(`Books saved to ${dataFile}`);
    if (!process.env.ANTHROPIC_API_KEY)
      console.log("Set ANTHROPIC_API_KEY to turn on the assistant.");
  });
}
