import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../src/server.js";
import { Books } from "../src/store.js";

let server;
let base;

before(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "books-"));
  const books = await Books.open(path.join(dir, "books.json"));
  server = createApp(books);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: { "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
  return {
    status: res.status,
    body: res.status === 204 ? null : await res.json().catch(() => null),
    res,
  };
};

test("serves the web app and blocks path traversal", async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Ask the assistant/);
  assert.equal((await fetch(`${base}/..%2Fsrc%2Fserver.js`)).status, 404);
});

test("customer, invoice, payment and report flow over HTTP", async () => {
  const customer = await call("POST", "/api/customers", {
    name: "Blue Fern Cafe",
    email: "hi@bluefern.example",
  });
  assert.equal(customer.status, 200);
  const invoice = await call("POST", "/api/invoices", {
    customerId: customer.body.id,
    items: [{ description: "Catering", quantity: "2", unitPrice: "150" }],
  });
  assert.equal(invoice.body.total, 30000);
  const paid = await call("POST", `/api/invoices/${invoice.body.id}/pay`, {
    paidDate: "2026-10-10",
  });
  assert.equal(paid.body.invoice.status, "paid");
  await call("POST", "/api/transactions", {
    type: "expense",
    amount: "75",
    date: "2026-10-11",
    category: "Rent",
    description: "Stall rent",
  });

  const pnl = await call(
    "GET",
    "/api/reports/profit-and-loss?from=2026-10-01&to=2026-10-31",
  );
  assert.equal(pnl.body.netProfit, 22500);
  const csv = await fetch(`${base}/api/export/transactions.csv`);
  assert.match(await csv.text(), /Stall rent,-75/);
});

test("bad requests get a 400 with a message", async () => {
  const res = await call("POST", "/api/transactions", {
    type: "expense",
    amount: "abc",
    description: "x",
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "amount must be a number");
  const notJson = await fetch(`${base}/api/customers`, {
    method: "POST",
    body: "[1]",
  });
  assert.equal(notJson.status, 400);
});

test("assistant endpoint explains when no API key is set", async () => {
  if (process.env.ANTHROPIC_API_KEY) return;
  const status = await call("GET", "/api/assistant");
  assert.equal(status.body.configured, false);
  const res = await call("POST", "/api/assistant", { message: "hi" });
  assert.equal(res.status, 503);
});
