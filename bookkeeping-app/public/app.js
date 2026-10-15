// Web UI for the bookkeeping app. Plain JavaScript, no build step.
const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");
const state = { settings: null, view: "dashboard", conversationId: null };

// ---------- helpers ----------

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

function fmt(cents) {
  const currency = state.settings?.currency || "USD";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

const today = () => new Date().toISOString().slice(0, 10);

function monthRange(offset = 0) {
  const now = new Date();
  const start = new Date(
    Date.UTC(now.getFullYear(), now.getMonth() + offset, 1),
  );
  const end = new Date(
    Date.UTC(now.getFullYear(), now.getMonth() + offset + 1, 0),
  );
  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
  };
}

const PERIODS = {
  "this-month": () => monthRange(0),
  "last-month": () => monthRange(-1),
  "this-year": () => ({
    from: `${new Date().getFullYear()}-01-01`,
    to: `${new Date().getFullYear()}-12-31`,
  }),
  "last-year": () => ({
    from: `${new Date().getFullYear() - 1}-01-01`,
    to: `${new Date().getFullYear() - 1}-12-31`,
  }),
  all: () => ({}),
};

function periodSelect(id, selected) {
  const labels = {
    "this-month": "This month",
    "last-month": "Last month",
    "this-year": "This year",
    "last-year": "Last year",
    all: "All time",
  };
  return `<select id="${id}">${Object.entries(labels)
    .map(
      ([v, l]) =>
        `<option value="${v}" ${v === selected ? "selected" : ""}>${l}</option>`,
    )
    .join("")}</select>`;
}

const qs = (params) =>
  new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== ""),
  ).toString();

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), 2600);
}

function options(list, selected) {
  return list
    .map(
      (v) => `<option ${v === selected ? "selected" : ""}>${esc(v)}</option>`,
    )
    .join("");
}

// Opens the shared dialog. `save` receives the form's fields; throwing keeps it open with the message.
function openForm(title, bodyHtml, save, { saveLabel = "Save", onOpen } = {}) {
  const dialog = $("#modal");
  const form = $("#modal-form");
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = bodyHtml;
  $("#modal-error").textContent = "";
  $("#modal-save").textContent = saveLabel;
  form.onsubmit = async (event) => {
    if (event.submitter?.value === "cancel") return;
    event.preventDefault();
    try {
      await save(Object.fromEntries(new FormData(form)), form);
      dialog.close();
      await refresh();
    } catch (error) {
      $("#modal-error").textContent = error.message;
    }
  };
  onOpen?.(form);
  dialog.showModal();
}

async function confirmThen(message, action) {
  if (!confirm(message)) return;
  try {
    await action();
    await refresh();
  } catch (error) {
    toast(error.message);
  }
}

// ---------- views ----------

const views = {
  async dashboard() {
    const period = state.dashboardPeriod || "this-month";
    const [summary, trend, recent] = await Promise.all([
      api(`/api/summary?${qs(PERIODS[period]())}`),
      api("/api/reports/monthly?months=6"),
      api("/api/transactions?limit=8"),
    ]);
    const max = Math.max(1, ...trend.flatMap((m) => [m.income, m.expenses]));
    view.innerHTML = `
      <div class="toolbar"><h1>Dashboard</h1><span class="spacer"></span>${periodSelect("period", period)}
        <button class="primary" data-new="income">+ Income</button><button class="primary" data-new="expense">+ Expense</button></div>
      <div class="cards">
        <div class="card"><div class="label">Income</div><div class="value income">${fmt(summary.totalIncome)}</div></div>
        <div class="card"><div class="label">Expenses</div><div class="value expense">${fmt(summary.totalExpenses)}</div></div>
        <div class="card"><div class="label">Net profit</div><div class="value">${fmt(summary.netProfit)}</div></div>
        <div class="card"><div class="label">Unpaid invoices</div><div class="value">${fmt(summary.outstandingAmount)}</div>
          <div class="sub">${summary.outstandingInvoices} open${summary.overdueInvoices ? `, <span class="expense">${summary.overdueInvoices} overdue (${fmt(summary.overdueAmount)})</span>` : ""}</div></div>
      </div>
      <div class="grid2">
        <div class="panel"><h2>Last 6 months</h2>
          <div class="bars">${trend
            .map(
              (
                m,
              ) => `<div class="bar-group" title="${m.month}: in ${fmt(m.income)}, out ${fmt(m.expenses)}">
                <div class="bar-pair"><div class="bar in" style="height:${(m.income / max) * 100}%"></div><div class="bar out" style="height:${(m.expenses / max) * 100}%"></div></div>
                <span class="muted">${new Date(`${m.month}-15`).toLocaleString(undefined, { month: "short" })}</span></div>`,
            )
            .join("")}</div>
          <div class="legend"><span class="in">Income</span><span class="out">Expenses</span></div>
        </div>
        <div class="panel"><h2>Top expenses</h2>
          ${summary.topExpenses.length ? `<table>${summary.topExpenses.map((e) => `<tr><td>${esc(e.category)}</td><td class="num">${fmt(e.amount)}</td></tr>`).join("")}</table>` : `<div class="empty">No expenses in this period.</div>`}
        </div>
      </div>
      <div class="panel" style="margin-top:12px"><h2>Recent activity</h2>${transactionTable(recent, { compact: true })}</div>`;
    $("#period").onchange = (e) => {
      state.dashboardPeriod = e.target.value;
      refresh();
    };
    view
      .querySelectorAll("[data-new]")
      .forEach(
        (b) => (b.onclick = () => transactionForm({ type: b.dataset.new })),
      );
    wireTransactionRows();
  },

  async transactions() {
    const f = state.txFilters || { type: "", search: "", period: "this-year" };
    const rows = await api(
      `/api/transactions?${qs({ type: f.type, search: f.search, ...PERIODS[f.period]() })}`,
    );
    const totalIn = rows
      .filter((t) => t.type === "income")
      .reduce((s, t) => s + t.amount, 0);
    const totalOut = rows
      .filter((t) => t.type === "expense")
      .reduce((s, t) => s + t.amount, 0);
    view.innerHTML = `
      <div class="toolbar"><h1>Transactions</h1><span class="spacer"></span>
        <button class="primary" data-new="income">+ Income</button><button class="primary" data-new="expense">+ Expense</button></div>
      <div class="toolbar">
        <input id="tx-search" placeholder="Search…" value="${esc(f.search)}" />
        <select id="tx-type"><option value="">All types</option><option value="income" ${f.type === "income" ? "selected" : ""}>Income</option><option value="expense" ${f.type === "expense" ? "selected" : ""}>Expenses</option></select>
        ${periodSelect("tx-period", f.period)}
        <span class="spacer"></span>
        <span class="muted">${rows.length} shown · in <span class="income">${fmt(totalIn)}</span> · out <span class="expense">${fmt(totalOut)}</span></span>
        <a href="/api/export/transactions.csv?${qs({ type: f.type, search: f.search, ...PERIODS[f.period]() })}"><button>Export CSV</button></a>
      </div>
      <div class="table-wrap">${transactionTable(rows)}</div>`;
    const update = (patch) => {
      state.txFilters = { ...f, ...patch };
      refresh();
    };
    $("#tx-type").onchange = (e) => update({ type: e.target.value });
    $("#tx-period").onchange = (e) => update({ period: e.target.value });
    $("#tx-search").onchange = (e) => update({ search: e.target.value });
    view
      .querySelectorAll("[data-new]")
      .forEach(
        (b) => (b.onclick = () => transactionForm({ type: b.dataset.new })),
      );
    wireTransactionRows();
  },

  async invoices() {
    const status = state.invoiceStatus || "";
    const [invoices, customers] = await Promise.all([
      api(`/api/invoices?${qs({ status })}`),
      api("/api/customers"),
    ]);
    view.innerHTML = `
      <div class="toolbar"><h1>Invoices</h1><span class="spacer"></span>
        <select id="inv-status"><option value="">All</option>${["draft", "sent", "paid", "void"].map((s) => `<option value="${s}" ${s === status ? "selected" : ""}>${s === "sent" ? "Unpaid" : s[0].toUpperCase() + s.slice(1)}</option>`).join("")}</select>
        <button class="primary" id="new-invoice">+ New invoice</button></div>
      <div class="table-wrap">${
        invoices.length
          ? `<table><thead><tr><th>#</th><th>Customer</th><th>Issued</th><th>Due</th><th>Status</th><th class="num">Total</th><th></th></tr></thead><tbody>
          ${invoices
            .map(
              (inv) => `<tr>
              <td>${inv.number}</td><td>${esc(inv.customerName)}</td><td>${inv.issueDate}</td><td>${inv.dueDate}</td>
              <td>${statusPill(inv)}</td><td class="num">${fmt(inv.total)}</td>
              <td class="num">
                <button class="link" data-view-inv="${inv.id}">View</button>
                ${inv.status === "sent" || inv.status === "draft" ? `<button class="link" data-pay="${inv.id}">Mark paid</button>` : ""}
                ${inv.status !== "paid" ? `<button class="link" data-edit-inv="${inv.id}">Edit</button><button class="link danger" data-del-inv="${inv.id}">Delete</button>` : ""}
              </td></tr>`,
            )
            .join("")}</tbody></table>`
          : `<div class="empty">No invoices yet.${customers.length ? "" : " Add a customer first."}</div>`
      }</div>`;
    $("#inv-status").onchange = (e) => {
      state.invoiceStatus = e.target.value;
      refresh();
    };
    $("#new-invoice").onclick = () =>
      customers.length ? invoiceForm(customers) : customerForm();
    const byId = new Map(invoices.map((i) => [i.id, i]));
    view.querySelectorAll("[data-pay]").forEach(
      (b) =>
        (b.onclick = () =>
          openForm(
            `Record payment for invoice #${byId.get(b.dataset.pay).number}`,
            `<p>This books ${fmt(byId.get(b.dataset.pay).total)} as income.</p><label>Payment date</label><input type="date" name="paidDate" value="${today()}" required />`,
            (data) =>
              api(`/api/invoices/${b.dataset.pay}/pay`, {
                method: "POST",
                body: data,
              }),
            { saveLabel: "Record payment" },
          )),
    );
    view
      .querySelectorAll("[data-edit-inv]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            invoiceForm(customers, byId.get(b.dataset.editInv))),
      );
    view
      .querySelectorAll("[data-view-inv]")
      .forEach(
        (b) => (b.onclick = () => showInvoice(byId.get(b.dataset.viewInv))),
      );
    view
      .querySelectorAll("[data-del-inv]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            confirmThen("Delete this invoice?", () =>
              api(`/api/invoices/${b.dataset.delInv}`, { method: "DELETE" }),
            )),
      );
  },

  async customers() {
    const customers = await api("/api/customers");
    view.innerHTML = `
      <div class="toolbar"><h1>Customers</h1><span class="spacer"></span><button class="primary" id="new-customer">+ New customer</button></div>
      <div class="table-wrap">${
        customers.length
          ? `<table><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th class="num">Owes you</th><th></th></tr></thead><tbody>
          ${customers
            .map(
              (
                c,
              ) => `<tr><td>${esc(c.name)}</td><td>${esc(c.email)}</td><td>${esc(c.phone)}</td><td class="num">${fmt(c.balanceDue)}</td>
              <td class="num"><button class="link" data-edit="${c.id}">Edit</button><button class="link danger" data-del="${c.id}">Delete</button></td></tr>`,
            )
            .join("")}</tbody></table>`
          : `<div class="empty">No customers yet.</div>`
      }</div>`;
    const byId = new Map(customers.map((c) => [c.id, c]));
    $("#new-customer").onclick = () => customerForm();
    view
      .querySelectorAll("[data-edit]")
      .forEach(
        (b) => (b.onclick = () => customerForm(byId.get(b.dataset.edit))),
      );
    view
      .querySelectorAll("[data-del]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            confirmThen(`Delete ${byId.get(b.dataset.del).name}?`, () =>
              api(`/api/customers/${b.dataset.del}`, { method: "DELETE" }),
            )),
      );
  },

  async reports() {
    const period = state.reportPeriod || "this-year";
    const range = PERIODS[period]();
    const pnl = await api(`/api/reports/profit-and-loss?${qs(range)}`);
    const lines = (list) =>
      list.length
        ? list
            .map(
              (l) =>
                `<tr><td style="padding-left:28px">${esc(l.category)}</td><td class="num">${fmt(l.amount)}</td></tr>`,
            )
            .join("")
        : `<tr><td style="padding-left:28px" class="muted">None</td><td></td></tr>`;
    view.innerHTML = `
      <div class="toolbar"><h1>Profit and loss</h1><span class="spacer"></span>${periodSelect("rp-period", period)}<button id="print">Print</button></div>
      <div class="panel">
        <p class="muted">${esc(state.settings.businessName)} · ${pnl.from ? `${pnl.from} to ${pnl.to}` : "All time"}</p>
        <table class="pnl">
          <tr class="section"><td>Income</td><td></td></tr>${lines(pnl.income)}
          <tr class="total"><td>Total income</td><td class="num">${fmt(pnl.totalIncome)}</td></tr>
          <tr class="section"><td>Expenses</td><td></td></tr>${lines(pnl.expenses)}
          <tr class="total"><td>Total expenses</td><td class="num">${fmt(pnl.totalExpenses)}</td></tr>
          <tr class="net"><td>Net profit</td><td class="num ${pnl.netProfit < 0 ? "expense" : "income"}">${fmt(pnl.netProfit)}</td></tr>
        </table>
      </div>`;
    $("#rp-period").onchange = (e) => {
      state.reportPeriod = e.target.value;
      refresh();
    };
    $("#print").onclick = () => window.print();
  },

  async settings() {
    const s = state.settings;
    view.innerHTML = `
      <h1>Settings</h1>
      <div class="grid2">
        <form class="panel" id="settings-form"><h2>Business</h2>
          <label>Business name</label><input name="businessName" value="${esc(s.businessName)}" required />
          <label>Currency (3-letter code)</label><input name="currency" value="${esc(s.currency)}" maxlength="3" required />
          <div class="actions"><button class="primary">Save</button></div></form>
        <div class="panel"><h2>Categories</h2>
          <p class="muted"><strong>Income:</strong> ${s.categories.income.map(esc).join(", ")}</p>
          <p class="muted"><strong>Expenses:</strong> ${s.categories.expense.map(esc).join(", ")}</p>
          <form id="cat-form" class="row"><select name="type"><option value="expense">Expense</option><option value="income">Income</option></select><input name="name" placeholder="New category" required /><button>Add</button></form>
        </div>
      </div>`;
    $("#settings-form").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api("/api/settings", {
          method: "PUT",
          body: Object.fromEntries(new FormData(e.target)),
        });
        toast("Saved");
        await refresh();
      } catch (error) {
        toast(error.message);
      }
    };
    $("#cat-form").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api("/api/categories", {
          method: "POST",
          body: Object.fromEntries(new FormData(e.target)),
        });
        await refresh();
      } catch (error) {
        toast(error.message);
      }
    };
  },
};

// ---------- shared pieces ----------

let lastTransactions = new Map();

function transactionTable(rows, { compact = false } = {}) {
  lastTransactions = new Map(rows.map((t) => [t.id, t]));
  if (!rows.length)
    return `<div class="empty">Nothing here yet. Add income or an expense, or tell the assistant about one.</div>`;
  return `<table><thead><tr><th>Date</th><th>Description</th><th>Category</th><th class="num">Amount</th>${compact ? "" : "<th></th>"}</tr></thead><tbody>
    ${rows
      .map(
        (
          t,
        ) => `<tr><td>${t.date}</td><td>${esc(t.description)}${t.source === "assistant" ? ' <span class="pill" title="Added by the assistant">AI</span>' : ""}</td>
        <td>${esc(t.category)}</td><td class="num ${t.type}">${t.type === "expense" ? "−" : "+"}${fmt(t.amount)}</td>
        ${compact ? "" : `<td class="num"><button class="link" data-edit-tx="${t.id}">Edit</button><button class="link danger" data-del-tx="${t.id}">Delete</button></td>`}</tr>`,
      )
      .join("")}</tbody></table>`;
}

function wireTransactionRows() {
  view
    .querySelectorAll("[data-edit-tx]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          transactionForm(lastTransactions.get(b.dataset.editTx))),
    );
  view
    .querySelectorAll("[data-del-tx]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          confirmThen("Delete this transaction?", () =>
            api(`/api/transactions/${b.dataset.delTx}`, { method: "DELETE" }),
          )),
    );
}

function transactionForm(tx = {}) {
  const editing = Boolean(tx.id);
  const type = tx.type || "expense";
  const cats = state.settings.categories;
  openForm(
    editing
      ? "Edit transaction"
      : type === "income"
        ? "Add income"
        : "Add expense",
    `<div class="row">
      <div><label>Type</label><select name="type" id="f-type"><option value="income" ${type === "income" ? "selected" : ""}>Income</option><option value="expense" ${type === "expense" ? "selected" : ""}>Expense</option></select></div>
      <div><label>Date</label><input type="date" name="date" value="${tx.date || today()}" required /></div>
      <div><label>Amount</label><input name="amount" inputmode="decimal" value="${tx.amount ? tx.amount / 100 : ""}" placeholder="0.00" required /></div>
    </div>
    <label>Description</label><input name="description" value="${esc(tx.description)}" placeholder="What was it for?" required />
    <label>Category</label><select name="category" id="f-cat">${options(cats[type], tx.category)}</select>`,
    (data) =>
      api(editing ? `/api/transactions/${tx.id}` : "/api/transactions", {
        method: editing ? "PUT" : "POST",
        body: data,
      }),
    {
      onOpen: (form) => {
        $("#f-type", form).onchange = (e) =>
          ($("#f-cat", form).innerHTML = options(cats[e.target.value]));
      },
    },
  );
}

function customerForm(c = {}) {
  openForm(
    c.id ? "Edit customer" : "New customer",
    `<label>Name</label><input name="name" value="${esc(c.name)}" required />
    <div class="row"><div><label>Email</label><input type="email" name="email" value="${esc(c.email)}" /></div><div><label>Phone</label><input name="phone" value="${esc(c.phone)}" /></div></div>
    <label>Address</label><textarea name="address" rows="2">${esc(c.address)}</textarea>`,
    (data) =>
      api(c.id ? `/api/customers/${c.id}` : "/api/customers", {
        method: c.id ? "PUT" : "POST",
        body: data,
      }),
  );
}

function itemRow(item = {}) {
  return `<div class="item"><input data-k="description" placeholder="Description" value="${esc(item.description)}" required />
    <input data-k="quantity" inputmode="decimal" value="${item.quantity ?? 1}" required />
    <input data-k="unitPrice" inputmode="decimal" placeholder="Price" value="${item.unitPrice !== undefined ? item.unitPrice / 100 : ""}" required />
    <button type="button" class="link danger" data-remove>✕</button></div>`;
}

function invoiceForm(customers, inv) {
  const issue = inv?.issueDate || today();
  const due =
    inv?.dueDate ||
    new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  openForm(
    inv ? `Edit invoice #${inv.number}` : "New invoice",
    `<label>Customer</label><select name="customerId" required>${customers.map((c) => `<option value="${c.id}" ${c.id === inv?.customerId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
    <div class="row"><div><label>Issue date</label><input type="date" name="issueDate" value="${issue}" required /></div><div><label>Due date</label><input type="date" name="dueDate" value="${due}" required /></div>
      <div><label>Status</label><select name="status"><option value="sent">Unpaid (sent)</option><option value="draft" ${inv?.status === "draft" ? "selected" : ""}>Draft</option></select></div></div>
    <label>Line items (description, qty, price)</label><div class="items" id="items">${(inv?.items || [{}]).map(itemRow).join("")}</div>
    <button type="button" class="link" id="add-item">+ Add line</button>
    <label>Notes</label><textarea name="notes" rows="2">${esc(inv?.notes)}</textarea>`,
    (data, form) => {
      const items = [...form.querySelectorAll(".item")].map((row) =>
        Object.fromEntries(
          [...row.querySelectorAll("input")].map((i) => [i.dataset.k, i.value]),
        ),
      );
      return api(inv ? `/api/invoices/${inv.id}` : "/api/invoices", {
        method: inv ? "PUT" : "POST",
        body: { ...data, items },
      });
    },
    {
      onOpen: (form) => {
        $("#add-item", form).onclick = () =>
          $("#items", form).insertAdjacentHTML("beforeend", itemRow());
        $("#items", form).onclick = (e) => {
          if (
            e.target.matches("[data-remove]") &&
            form.querySelectorAll(".item").length > 1
          )
            e.target.closest(".item").remove();
        };
      },
    },
  );
}

function showInvoice(inv) {
  openForm(
    `Invoice #${inv.number}`,
    `<p><strong>${esc(state.settings.businessName)}</strong><br/>Bill to: ${esc(inv.customerName)}<br/>
      <span class="muted">Issued ${inv.issueDate} · Due ${inv.dueDate}</span> ${statusPill(inv)}</p>
    <table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead><tbody>
    ${inv.items.map((i) => `<tr><td>${esc(i.description)}</td><td class="num">${i.quantity}</td><td class="num">${fmt(i.unitPrice)}</td><td class="num">${fmt(Math.round(i.quantity * i.unitPrice))}</td></tr>`).join("")}
    <tr><td colspan="3"><strong>Total</strong></td><td class="num"><strong>${fmt(inv.total)}</strong></td></tr></tbody></table>
    ${inv.notes ? `<p class="muted">${esc(inv.notes)}</p>` : ""}`,
    async () => window.print(),
    { saveLabel: "Print" },
  );
}

function statusPill(inv) {
  if (inv.overdue) return `<span class="pill overdue">Overdue</span>`;
  const label = {
    draft: "Draft",
    sent: "Unpaid",
    paid: `Paid ${inv.paidDate || ""}`,
    void: "Void",
  }[inv.status];
  return `<span class="pill ${inv.status}">${label}</span>`;
}

// ---------- navigation ----------

async function refresh() {
  try {
    state.settings = await api("/api/settings");
    $("#business-name").textContent = state.settings.businessName;
    document.title = `${state.settings.businessName} · Books`;
    await views[state.view]();
  } catch (error) {
    view.innerHTML = `<div class="empty">Couldn't load: ${esc(error.message)}</div>`;
  }
}

$("#tabs").onclick = (e) => {
  const button = e.target.closest("button[data-view]");
  if (!button) return;
  state.view = button.dataset.view;
  document
    .querySelectorAll("#tabs button")
    .forEach((b) => b.classList.toggle("active", b === button));
  refresh();
};

// ---------- assistant ----------

const log = $("#chat-log");

function bubble(kind, text) {
  const el = document.createElement("div");
  el.className = `bubble ${kind}`;
  el.textContent = text;
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

const ACTION_LABELS = {
  add_transaction: (i) =>
    `Recorded ${i.type} of ${fmt(Math.round(i.amount * 100))} (${i.category})`,
  update_transaction: () => "Updated a transaction",
  add_customer: (i) => `Added customer ${i.name}`,
  create_invoice: () => "Created an invoice",
  mark_invoice_paid: (i) => `Marked invoice ${i.invoice} paid`,
};

$("#assistant-toggle").onclick = async () => {
  const panel = $("#assistant");
  panel.classList.toggle("hidden");
  if (!panel.classList.contains("hidden")) {
    $("#chat-input").focus();
    const status = await api("/api/assistant").catch(() => null);
    $("#assistant-model").textContent = status?.configured ? "" : "Not set up";
    if (status && !status.configured && !state.warned) {
      state.warned = true;
      bubble(
        "err",
        "The assistant isn't set up yet. Start the app with an ANTHROPIC_API_KEY to turn it on. Everything else works without it.",
      );
    }
  }
};
$("#assistant-close").onclick = () => $("#assistant").classList.add("hidden");
$("#assistant-new").onclick = () => {
  state.conversationId = null;
  log.replaceChildren();
  bubble("bot", "New chat started. What can I help with?");
};

$("#chat-input").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#chat-form").requestSubmit();
  }
};

$("#chat-form").onsubmit = async (e) => {
  e.preventDefault();
  const input = $("#chat-input");
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  bubble("me", message);
  const thinking = bubble("bot", "Working on it…");
  const send = $("#chat-form button");
  send.disabled = true;
  try {
    const result = await api("/api/assistant", {
      method: "POST",
      body: { conversationId: state.conversationId, message },
    });
    state.conversationId = result.conversationId;
    thinking.remove();
    for (const action of result.actions)
      bubble(
        "note",
        `✓ ${(ACTION_LABELS[action.tool] || (() => action.tool))(action.input)}`,
      );
    bubble("bot", result.reply);
    if (result.changed) await refresh();
  } catch (error) {
    thinking.remove();
    bubble("err", error.message);
  } finally {
    send.disabled = false;
  }
};

bubble(
  "bot",
  'Hi! Tell me about money in or out, like "paid $45 for printer ink today", or ask a question like "what was my profit last month?"',
);
refresh();
