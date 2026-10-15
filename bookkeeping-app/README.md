# Bookkeeping app

Simple books for small business owners: record money in and out, keep a
customer list, send and track invoices, and see profit and loss. A built-in
assistant powered by Claude answers questions about the books and records
transactions from plain sentences like "paid $45 for printer ink today".

This app is separate from REA and does not use any REA code.

## Run it

Needs Node.js 20 or newer.

```bash
cd bookkeeping-app
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
```

Open http://127.0.0.1:3000. Everything except the assistant works without an
API key.

Settings (environment variables):

| Variable            | Default            | What it does                       |
| ------------------- | ------------------ | ---------------------------------- |
| `ANTHROPIC_API_KEY` | none               | Turns on the assistant             |
| `BOOKS_FILE`        | `data/books.json`  | Where the books are saved          |
| `PORT` / `HOST`     | `3000` / localhost | Where the app listens              |
| `BOOKKEEPING_MODEL` | `claude-opus-5-5`  | Claude model used by the assistant |

The books are one JSON file. Back it up by copying it. The app has no login,
so it listens on localhost only by default; put it behind authentication
before exposing it to a network.

## What it does

- **Dashboard**: income, expenses, net profit and unpaid invoices for a
  period, a six-month chart, top expense categories and recent activity.
- **Transactions**: add, edit, delete, search and filter income and expenses;
  export to CSV for your accountant.
- **Invoices**: line items, due dates, overdue flags, print view. Marking an
  invoice paid books the income automatically.
- **Customers**: contact details and what each customer owes.
- **Reports**: profit and loss by category for any period, printable.
- **Settings**: business name, currency, custom categories.
- **Assistant**: ask "what did I spend on rent this year?", "who owes me
  money?", or "invoice Blue Fern Cafe for 10 hours at $80". Anything it records
  shows up in a note in the chat and is tagged "AI" in the transaction list,
  so it is easy to check and correct.

## How the assistant works

`src/agent.js` gives Claude a fixed set of tools over the books (summary,
profit and loss, monthly trend, list and add transactions, customers and
invoices, mark an invoice paid). Every write goes through the same
validation as the web forms in `src/store.js`; validation errors are sent back
to Claude so it can correct itself or ask the owner. Conversations are kept in
memory on the server and reset when the server restarts.

## Tests

```bash
npm test
```

Tests cover the ledger rules, the HTTP API, and the assistant's tool loop with
a scripted stand-in for the Claude API. They do not call the real API.
