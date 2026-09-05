# Ticket Service

A small NestJS service for taking in support tickets, classifying them in the
background, and reading the results back over HTTP.

The classifier is fake on purpose. I used a fake client that returns normal JSON most of the time and broken
responses sometimes. The more important part here is that the application
treats the classifier response as untrusted text.

## Running It

You need Node 20+.

```bash
npm install
cp .env.example .env
npx prisma migrate deploy
npm run start:dev
```

The server runs on port `3000`.

To load the sample tickets from the appendix, keep the server running and run below command:

```bash
npm run seed
```

A couple of example requests:

```bash
curl http://localhost:3000/tickets/t-1005
curl "http://localhost:3000/tickets?category=billing&priority=high"
```

## Tests

```bash
npm test
npm run test:e2e
```

The e2e test uses a separate SQLite database and sets the fake classifier's
latency and failure rate to zero, so the test is not flaky.

## API

- `POST /tickets`
  - Body: `{ id, subject, body }`
  - Returns `201` for a new ticket.
  - Returns `200` if the ID already exists. In that case it returns the stored
    ticket and does not classify again.
- `GET /tickets/:id`
  - Returns one ticket.
  - Returns `404` if the ticket does not exist.
- `GET /tickets`
  - Optional filters: `category`, `priority`, `page`, `pageSize`
  - Default `page` is `1`
  - Default `pageSize` is `20`
  - Response shape: `{ data, page, pageSize, total }`
- `POST /tickets/:id/reclassify`
  - Requeues a ticket that is already `classified` or `failed`.
  - Returns `409` if the ticket is already `pending` or `processing`.
- `GET /health`

## Ticket Lifecycle

```text
pending -> processing -> classified
                    \
                     -> failed
```

`pending` means the ticket has been stored and is waiting for the worker.
`processing` means the worker has claimed it. `classified` means the category,
priority, and summary were validated and stored. `failed` means the classifier
kept returning errors or invalid output until the retry limit was reached.

## Main Choices

### Storage

I used SQLite through Prisma. For this exercise I wanted the reviewer to be able
to run the service without Docker or a hosted database. SQLite is enough to show
persistence, filtering, migrations, and unique ticket IDs.

For a real multi-instance service I would move this to Postgres.

### Async Work

Classification does not happen inside the `POST /tickets` request. The request
stores the ticket as `pending`, returns to the caller, and then an in-process
queue picks it up.

The queue is deliberately simple: an array plus a small concurrency counter.
`CLASSIFY_CONCURRENCY` controls how many classifications can run at once. The
default is `2`.

### Duplicate Tickets

The ticket ID acts as the idempotency key. If the same ID is submitted again, I
return the existing ticket and do not enqueue classification again.

I chose not to compare the new subject/body with the old one. The brief only
says that submitting the same ID twice must not duplicate or rerun
classification, so I kept the behavior simple: existing ID means existing
ticket wins.

### Restart Behavior

The queue itself is in memory, so it does not survive a process restart. To make
that okay, the database status is the source of truth.

On startup, the service resets any ticket left in `processing` back to
`pending`, then requeues all pending tickets. If the process died mid
classification, the ticket gets another chance after restart instead of getting
stuck forever.

### Retries

Classifier failures are retried up to `CLASSIFY_MAX_ATTEMPTS`, which defaults
to `3`. 


After the final failed attempt, the ticket moves to `failed` and stores the
error message in `lastError`.

### Model Validation

The fake LLM client returns raw text, not a typed object. The worker then:

1. Parses it as JSON
2. Validates category, priority, and summary with Zod
3. Stores only the validated result

Bad JSON, missing fields, or values outside the allowed sets are not stored as
classification data.

### Prompt Injection

Ticket content is treated as user data, not instructions. The fake classifier
looks for topic words such as `invoice`, `error`, or `credentials`. It does not
use category labels like `technical` or priority labels like `high` as signals,
because the prompt-injection sample includes exactly those words.

For example, `t-1005` tries to force the result to `technical` and asks for a
refund-style summary. The classifier still returns `billing`, because the real
question is about downloading invoices.

With a real LLM, I would keep the system instruction separate from the ticket
text and pass the ticket body as clearly delimited untrusted input. I would
still keep the same output validation, because model output can be wrong even
with a careful prompt.

## Things I Would Improve

- The fake classifier is keyword-based and gets some ambiguous cases wrong.
  `t-1009` is a good example: it is mainly about a data export, but it also
  mentions being overcharged, so the current keyword order can pull it toward
  billing.
- Summaries are basic. They are more like short snippets than real summaries.
- Retry scheduling is only in memory. A production system would store the next
  retry time in the database.
- There is no auth, rate limiting, or request-size middleware beyond field
  length validation.
- The database uses strings for status/category/priority. I would tighten this
  with enums or database-level checks in a production version.
- Pagination uses `skip` and `take`, which is fine for this small dataset but
  not ideal for very large tables.


## Project Layout

```text
src/
  tickets/          create, read, list, and reclassify tickets
  classification/   fake LLM client, queue, and response validation
  prisma/           Prisma service
  common/           HTTP exception filter

prisma/schema.prisma          Ticket table model
fixtures/tickets.sample.json  sample tickets from the appendix
scripts/seed.ts               loads the sample tickets through the API
```
