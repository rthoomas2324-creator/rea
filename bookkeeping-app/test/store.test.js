import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Books, ValidationError } from "../src/store.js";

async function freshBooks() {
  const dir = await mkdtemp(path.join(tmpdir(), "books-"));
  return Books.open(path.join(dir, "books.json"));
}

test("records income and expenses in cents and reports profit and loss", async () => {
  const books = await freshBooks();
  await books.addTransaction({
    type: "income",
    amount: "1,200.50",
    date: "2026-03-02",
    category: "Sales",
    description: "Website job",
  });
  await books.addTransaction({
    type: "expense",
    amount: 0.1,
    date: "2026-03-03",
    category: "Bank fees",
    description: "Fee",
  });
  await books.addTransaction({
    type: "expense",
    amount: 0.2,
    date: "2026-03-04",
    category: "bank fees",
    description: "Fee",
  });
  await books.addTransaction({
    type: "expense",
    amount: 99,
    date: "2026-04-01",
    category: "Software",
    description: "Outside range",
  });

  const pnl = books.profitAndLoss({ from: "2026-03-01", to: "2026-03-31" });
  assert.equal(pnl.totalIncome, 120050);
  assert.deepEqual(pnl.expenses, [{ category: "Bank fees", amount: 30 }]);
  assert.equal(pnl.netProfit, 120020);
});

test("rejects bad input with a readable message", async () => {
  const books = await freshBooks();
  await assert.rejects(
    books.addTransaction({ type: "income", amount: -5, description: "x" }),
    ValidationError,
  );
  await assert.rejects(
    books.addTransaction({ type: "gift", amount: 5, description: "x" }),
    /Type must be one of/,
  );
  await assert.rejects(
    books.addTransaction({
      type: "income",
      amount: 5,
      date: "2026-02-30",
      description: "x",
    }),
    /not a real date/,
  );
});

test("new category names are added once, matching case-insensitively", async () => {
  const books = await freshBooks();
  await books.addTransaction({
    type: "expense",
    amount: 5,
    category: "Coffee beans",
    description: "a",
  });
  await books.addTransaction({
    type: "expense",
    amount: 5,
    category: "coffee BEANS",
    description: "b",
  });
  assert.equal(
    books.getSettings().categories.expense.filter((c) => c === "Coffee beans")
      .length,
    1,
  );
});

test("paying an invoice books the income; deleting that payment reopens it", async () => {
  const books = await freshBooks();
  const customer = await books.addCustomer({ name: "Ada's Bakery" });
  const invoice = await books.createInvoice({
    customerId: customer.id,
    issueDate: "2026-01-01",
    dueDate: "2026-01-31",
    items: [
      { description: "Logo", quantity: 1, unitPrice: 300 },
      { description: "Hours", quantity: 2.5, unitPrice: "80" },
    ],
  });
  assert.equal(invoice.total, 50000);
  assert.equal(invoice.number, 1001);
  assert.equal(invoice.overdue, true);
  assert.equal(books.listCustomers()[0].balanceDue, 50000);

  const { transaction } = await books.markInvoicePaid(String(invoice.number), {
    paidDate: "2026-02-05",
  });
  assert.equal(transaction.amount, 50000);
  assert.equal(books.getInvoice(invoice.id).status, "paid");
  assert.equal(books.listCustomers()[0].balanceDue, 0);
  await assert.rejects(books.markInvoicePaid(invoice.id), /already paid/);

  await books.deleteTransaction(transaction.id);
  assert.equal(books.getInvoice(invoice.id).status, "sent");
});

test("books survive a reload from disk", async () => {
  const books = await freshBooks();
  await books.updateSettings({ businessName: "Corner Shop", currency: "eur" });
  await books.addTransaction({
    type: "income",
    amount: 10,
    description: "Sale",
  });
  const reopened = await Books.open(books.filePath);
  assert.equal(reopened.getSettings().currency, "EUR");
  assert.equal(reopened.listTransactions().length, 1);
  JSON.parse(await readFile(books.filePath, "utf8"));
});

test("CSV export signs expenses and neutralizes formula-like text", async () => {
  const books = await freshBooks();
  await books.addTransaction({
    type: "expense",
    amount: 12.5,
    date: "2026-05-01",
    category: "Meals",
    description: '=HYPERLINK("x")',
  });
  const csv = books.exportTransactionsCsv({});
  assert.match(csv, /2026-05-01,expense,Meals,"'=HYPERLINK\(""x""\)",-12.5,/);
});
