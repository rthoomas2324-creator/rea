// The books: a small JSON-file store for settings, customers, transactions and
// invoices. Money is kept as integer cents so totals never drift.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const TRANSACTION_TYPES = ["income", "expense"];
export const INVOICE_STATUSES = ["draft", "sent", "paid", "void"];

export const DEFAULT_CATEGORIES = {
  income: ["Sales", "Services", "Interest", "Other income"],
  expense: [
    "Advertising",
    "Bank fees",
    "Contractors",
    "Equipment",
    "Insurance",
    "Meals",
    "Office supplies",
    "Rent",
    "Software",
    "Travel",
    "Utilities",
    "Wages",
    "Other expense",
  ],
};

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

function emptyBooks() {
  return {
    settings: { businessName: "My Business", currency: "USD" },
    categories: structuredClone(DEFAULT_CATEGORIES),
    customers: [],
    transactions: [],
    invoices: [],
    nextInvoiceNumber: 1001,
  };
}

// Parsing helpers. Each turns an untrusted value into a clean one or throws a
// ValidationError naming the field, so the UI and the assistant get the same rules.

function requireText(value, field, { max = 200, optional = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (optional) return "";
    throw new ValidationError(`${field} is required`);
  }
  if (typeof value !== "string")
    throw new ValidationError(`${field} must be text`);
  const text = value.trim();
  if (!text && !optional) throw new ValidationError(`${field} is required`);
  if (text.length > max)
    throw new ValidationError(`${field} must be ${max} characters or fewer`);
  return text;
}

function requireDate(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError(`${field} must be a date like 2026-01-31`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new ValidationError(`${field} is not a real date`);
  }
  return value;
}

function optionalDate(value, field) {
  return value === undefined || value === null || value === ""
    ? undefined
    : requireDate(value, field);
}

// Accepts dollars as a number or numeric string ("12.5", 12.5) and returns cents.
export function toCents(value, field = "amount", { allowZero = false } = {}) {
  const number =
    typeof value === "string" ? Number(value.replace(/[$,\s]/g, "")) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) {
    throw new ValidationError(`${field} must be a number`);
  }
  const cents = Math.round(number * 100);
  if (cents < 0 || (!allowZero && cents === 0)) {
    throw new ValidationError(`${field} must be greater than zero`);
  }
  if (cents > 100_000_000_000)
    throw new ValidationError(`${field} is too large`);
  return cents;
}

function requireOneOf(value, field, allowed) {
  if (!allowed.includes(value)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function inRange(date, from, to) {
  return (!from || date >= from) && (!to || date <= to);
}

export class Books {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = emptyBooks();
    this.queue = Promise.resolve();
  }

  static async open(filePath) {
    const books = new Books(filePath);
    try {
      const raw = await readFile(filePath, "utf8");
      books.data = { ...emptyBooks(), ...JSON.parse(raw) };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await books.save();
    }
    return books;
  }

  // Writes go to a temp file and are renamed into place, one at a time, so a
  // crash mid-write never leaves half a ledger on disk.
  save() {
    const write = async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(this.data, null, 2));
      await rename(temp, this.filePath);
    };
    this.queue = this.queue.then(write, write);
    return this.queue;
  }

  // Settings and categories

  getSettings() {
    return { ...this.data.settings, categories: this.data.categories };
  }

  async updateSettings(input) {
    const settings = this.data.settings;
    if (input.businessName !== undefined) {
      settings.businessName = requireText(input.businessName, "Business name", {
        max: 120,
      });
    }
    if (input.currency !== undefined) {
      const currency = requireText(input.currency, "Currency", {
        max: 3,
      }).toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency))
        throw new ValidationError("Currency must be a 3-letter code like USD");
      settings.currency = currency;
    }
    await this.save();
    return this.getSettings();
  }

  async addCategory(type, name) {
    requireOneOf(type, "Type", TRANSACTION_TYPES);
    const label = requireText(name, "Category", { max: 60 });
    const list = this.data.categories[type];
    const existing = list.find((c) => c.toLowerCase() === label.toLowerCase());
    if (existing) return existing;
    list.push(label);
    await this.save();
    return label;
  }

  // Unknown categories are added rather than rejected: owners name things their own way.
  async ensureCategory(type, name) {
    const label = requireText(name, "Category", { max: 60 });
    const existing = this.data.categories[type].find(
      (c) => c.toLowerCase() === label.toLowerCase(),
    );
    return existing ?? this.addCategory(type, label);
  }

  // Customers

  listCustomers({ search } = {}) {
    const needle = search?.toLowerCase();
    return this.data.customers
      .filter(
        (c) =>
          !needle ||
          [c.name, c.email, c.phone].some((v) =>
            v?.toLowerCase().includes(needle),
          ),
      )
      .map((c) => ({ ...c, balanceDue: this.customerBalance(c.id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getCustomer(id) {
    const customer = this.data.customers.find((c) => c.id === id);
    if (!customer) throw new NotFoundError(`No customer with id ${id}`);
    return customer;
  }

  customerBalance(customerId) {
    return this.data.invoices
      .filter((inv) => inv.customerId === customerId && inv.status === "sent")
      .reduce((sum, inv) => sum + invoiceTotal(inv), 0);
  }

  parseCustomer(input) {
    return {
      name: requireText(input.name, "Name", { max: 120 }),
      email: requireText(input.email, "Email", { max: 200, optional: true }),
      phone: requireText(input.phone, "Phone", { max: 40, optional: true }),
      address: requireText(input.address, "Address", {
        max: 300,
        optional: true,
      }),
      notes: requireText(input.notes, "Notes", { max: 1000, optional: true }),
    };
  }

  async addCustomer(input) {
    const customer = {
      id: randomUUID(),
      ...this.parseCustomer(input),
      createdAt: new Date().toISOString(),
    };
    this.data.customers.push(customer);
    await this.save();
    return customer;
  }

  async updateCustomer(id, input) {
    const customer = this.getCustomer(id);
    Object.assign(customer, this.parseCustomer({ ...customer, ...input }));
    await this.save();
    return customer;
  }

  async deleteCustomer(id) {
    this.getCustomer(id);
    if (this.data.invoices.some((inv) => inv.customerId === id)) {
      throw new ValidationError(
        "This customer has invoices. Void or delete those first.",
      );
    }
    this.data.customers = this.data.customers.filter((c) => c.id !== id);
    for (const t of this.data.transactions)
      if (t.customerId === id) t.customerId = null;
    await this.save();
  }

  // Transactions

  async parseTransaction(input) {
    const type = requireOneOf(input.type, "Type", TRANSACTION_TYPES);
    const customerId = input.customerId || null;
    if (customerId) this.getCustomer(customerId);
    return {
      date: requireDate(input.date ?? today(), "Date"),
      type,
      amount: toCents(input.amount),
      category: await this.ensureCategory(
        type,
        input.category ||
          (type === "income" ? "Other income" : "Other expense"),
      ),
      description: requireText(input.description, "Description", { max: 300 }),
      customerId,
    };
  }

  listTransactions({ type, category, from, to, search, limit } = {}) {
    if (type) requireOneOf(type, "Type", TRANSACTION_TYPES);
    from = optionalDate(from, "From");
    to = optionalDate(to, "To");
    const needle = search?.toLowerCase();
    const rows = this.data.transactions
      .filter((t) => (!type || t.type === type) && inRange(t.date, from, to))
      .filter(
        (t) => !category || t.category.toLowerCase() === category.toLowerCase(),
      )
      .filter(
        (t) =>
          !needle ||
          t.description.toLowerCase().includes(needle) ||
          t.category.toLowerCase().includes(needle),
      )
      .sort(
        (a, b) =>
          b.date.localeCompare(a.date) ||
          b.createdAt.localeCompare(a.createdAt),
      );
    return limit ? rows.slice(0, limit) : rows;
  }

  getTransaction(id) {
    const transaction = this.data.transactions.find((t) => t.id === id);
    if (!transaction) throw new NotFoundError(`No transaction with id ${id}`);
    return transaction;
  }

  async addTransaction(input, { source = "manual" } = {}) {
    const transaction = {
      id: randomUUID(),
      ...(await this.parseTransaction(input)),
      invoiceId: input.invoiceId ?? null,
      source,
      createdAt: new Date().toISOString(),
    };
    this.data.transactions.push(transaction);
    await this.save();
    return transaction;
  }

  async updateTransaction(id, input) {
    const transaction = this.getTransaction(id);
    const merged = {
      ...transaction,
      amount: transaction.amount / 100,
      ...input,
    };
    Object.assign(transaction, await this.parseTransaction(merged), {
      updatedAt: new Date().toISOString(),
    });
    await this.save();
    return transaction;
  }

  async deleteTransaction(id) {
    const transaction = this.getTransaction(id);
    if (transaction.invoiceId) {
      const invoice = this.data.invoices.find(
        (inv) => inv.id === transaction.invoiceId,
      );
      if (invoice?.status === "paid") {
        invoice.status = "sent";
        invoice.paidDate = null;
      }
    }
    this.data.transactions = this.data.transactions.filter((t) => t.id !== id);
    await this.save();
  }

  // Invoices

  parseItems(items) {
    if (!Array.isArray(items) || items.length === 0)
      throw new ValidationError("Add at least one line item");
    if (items.length > 100)
      throw new ValidationError("An invoice can have at most 100 line items");
    return items.map((item, i) => {
      const quantity = Number(item.quantity ?? 1);
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) {
        throw new ValidationError(
          `Line ${i + 1}: quantity must be greater than zero`,
        );
      }
      return {
        description: requireText(
          item.description,
          `Line ${i + 1} description`,
          { max: 300 },
        ),
        quantity,
        unitPrice: toCents(item.unitPrice, `Line ${i + 1} price`, {
          allowZero: true,
        }),
      };
    });
  }

  listInvoices({ status, customerId } = {}) {
    if (status) requireOneOf(status, "Status", INVOICE_STATUSES);
    const now = today();
    return this.data.invoices
      .filter(
        (inv) =>
          (!status || inv.status === status) &&
          (!customerId || inv.customerId === customerId),
      )
      .map((inv) => this.describeInvoice(inv, now))
      .sort((a, b) => b.number - a.number);
  }

  describeInvoice(invoice, now = today()) {
    const customer = this.data.customers.find(
      (c) => c.id === invoice.customerId,
    );
    return {
      ...invoice,
      customerName: customer?.name ?? "(deleted customer)",
      total: invoiceTotal(invoice),
      overdue: invoice.status === "sent" && invoice.dueDate < now,
    };
  }

  getInvoice(id) {
    const invoice = this.data.invoices.find(
      (inv) => inv.id === id || String(inv.number) === String(id),
    );
    if (!invoice) throw new NotFoundError(`No invoice with id or number ${id}`);
    return invoice;
  }

  async createInvoice(input) {
    this.getCustomer(input.customerId);
    const issueDate = requireDate(input.issueDate ?? today(), "Issue date");
    const dueDate = requireDate(
      input.dueDate ?? addDays(issueDate, 30),
      "Due date",
    );
    if (dueDate < issueDate)
      throw new ValidationError("Due date can't be before the issue date");
    const invoice = {
      id: randomUUID(),
      number: this.data.nextInvoiceNumber++,
      customerId: input.customerId,
      issueDate,
      dueDate,
      items: this.parseItems(input.items),
      notes: requireText(input.notes, "Notes", { max: 1000, optional: true }),
      status: input.status === "draft" ? "draft" : "sent",
      paidDate: null,
      createdAt: new Date().toISOString(),
    };
    this.data.invoices.push(invoice);
    await this.save();
    return this.describeInvoice(invoice);
  }

  async updateInvoice(id, input) {
    const invoice = this.getInvoice(id);
    if (invoice.status === "paid")
      throw new ValidationError(
        "Paid invoices can't be edited. Delete the payment first.",
      );
    if (input.customerId !== undefined)
      invoice.customerId = this.getCustomer(input.customerId).id;
    if (input.issueDate !== undefined)
      invoice.issueDate = requireDate(input.issueDate, "Issue date");
    if (input.dueDate !== undefined)
      invoice.dueDate = requireDate(input.dueDate, "Due date");
    if (input.items !== undefined) invoice.items = this.parseItems(input.items);
    if (input.notes !== undefined)
      invoice.notes = requireText(input.notes, "Notes", {
        max: 1000,
        optional: true,
      });
    if (input.status !== undefined) {
      requireOneOf(input.status, "Status", ["draft", "sent", "void"]);
      invoice.status = input.status;
    }
    await this.save();
    return this.describeInvoice(invoice);
  }

  // Recording payment books the income, so reports and the dashboard stay in step.
  async markInvoicePaid(id, { paidDate, category = "Sales" } = {}) {
    const invoice = this.getInvoice(id);
    if (invoice.status === "paid")
      throw new ValidationError(`Invoice #${invoice.number} is already paid`);
    if (invoice.status === "void")
      throw new ValidationError(`Invoice #${invoice.number} is void`);
    const date = requireDate(paidDate ?? today(), "Paid date");
    const total = invoiceTotal(invoice);
    if (total <= 0)
      throw new ValidationError("This invoice has no amount to pay");
    const customer = this.data.customers.find(
      (c) => c.id === invoice.customerId,
    );
    const transaction = await this.addTransaction(
      {
        date,
        type: "income",
        amount: total / 100,
        category,
        description: `Payment for invoice #${invoice.number}${customer ? ` (${customer.name})` : ""}`,
        customerId: invoice.customerId,
        invoiceId: invoice.id,
      },
      { source: "invoice" },
    );
    invoice.status = "paid";
    invoice.paidDate = date;
    await this.save();
    return { invoice: this.describeInvoice(invoice), transaction };
  }

  async deleteInvoice(id) {
    const invoice = this.getInvoice(id);
    if (invoice.status === "paid")
      throw new ValidationError(
        "Delete the payment transaction before deleting a paid invoice",
      );
    this.data.invoices = this.data.invoices.filter(
      (inv) => inv.id !== invoice.id,
    );
    await this.save();
  }

  // Reports

  profitAndLoss({ from, to } = {}) {
    from = optionalDate(from, "From");
    to = optionalDate(to, "To");
    const groups = { income: new Map(), expense: new Map() };
    for (const t of this.data.transactions) {
      if (!inRange(t.date, from, to)) continue;
      const group = groups[t.type];
      group.set(t.category, (group.get(t.category) ?? 0) + t.amount);
    }
    const lines = (map) =>
      [...map]
        .map(([category, amount]) => ({ category, amount }))
        .sort((a, b) => b.amount - a.amount);
    const income = lines(groups.income);
    const expenses = lines(groups.expense);
    const totalIncome = income.reduce((s, l) => s + l.amount, 0);
    const totalExpenses = expenses.reduce((s, l) => s + l.amount, 0);
    return {
      from: from ?? null,
      to: to ?? null,
      income,
      expenses,
      totalIncome,
      totalExpenses,
      netProfit: totalIncome - totalExpenses,
    };
  }

  // Monthly income and expense totals for the last `months` months, oldest first.
  monthlyTrend(months = 6, now = new Date()) {
    const buckets = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
      );
      buckets.push({
        month: d.toISOString().slice(0, 7),
        income: 0,
        expenses: 0,
      });
    }
    const byMonth = new Map(buckets.map((b) => [b.month, b]));
    for (const t of this.data.transactions) {
      const bucket = byMonth.get(t.date.slice(0, 7));
      if (!bucket) continue;
      if (t.type === "income") bucket.income += t.amount;
      else bucket.expenses += t.amount;
    }
    return buckets;
  }

  summary({ from, to } = {}) {
    const pnl = this.profitAndLoss({ from, to });
    const open = this.listInvoices({ status: "sent" });
    return {
      businessName: this.data.settings.businessName,
      currency: this.data.settings.currency,
      from: pnl.from,
      to: pnl.to,
      totalIncome: pnl.totalIncome,
      totalExpenses: pnl.totalExpenses,
      netProfit: pnl.netProfit,
      topExpenses: pnl.expenses.slice(0, 5),
      outstandingInvoices: open.length,
      outstandingAmount: open.reduce((s, inv) => s + inv.total, 0),
      overdueInvoices: open.filter((inv) => inv.overdue).length,
      overdueAmount: open
        .filter((inv) => inv.overdue)
        .reduce((s, inv) => s + inv.total, 0),
      customerCount: this.data.customers.length,
      transactionCount: this.data.transactions.length,
    };
  }

  exportTransactionsCsv(filters) {
    const names = new Map(this.data.customers.map((c) => [c.id, c.name]));
    const rows = this.listTransactions(filters).map((t) => [
      t.date,
      t.type,
      t.category,
      t.description,
      (t.type === "expense" ? -t.amount : t.amount) / 100,
      names.get(t.customerId) ?? "",
    ]);
    return (
      [
        ["Date", "Type", "Category", "Description", "Amount", "Customer"],
        ...rows,
      ]
        .map(csvRow)
        .join("\n") + "\n"
    );
  }
}

export function invoiceTotal(invoice) {
  return invoice.items.reduce(
    (sum, item) => sum + Math.round(item.quantity * item.unitPrice),
    0,
  );
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function csvRow(values) {
  return values
    .map((v) => {
      let text = String(v);
      // Keep spreadsheet apps from treating cell text as a formula.
      if (/^[=+\-@\t\r]/.test(text) && typeof v === "string") text = `'${text}`;
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    })
    .join(",");
}
