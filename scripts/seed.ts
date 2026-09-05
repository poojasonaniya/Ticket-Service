// Loads fixtures/tickets.sample.json into a running instance via its own
// HTTP API. Server needs to be up first (npm run start:dev).
//
// npm run seed
// BASE_URL=http://localhost:4000 npm run seed
import { readFileSync } from 'fs';
import { join } from 'path';

interface SampleTicket {
  id: string;
  subject: string;
  body: string;
}

async function main() {
  const baseUrl = process.env.BASE_URL ?? 'http://localhost:3000';
  const fixturePath = join(__dirname, '..', 'fixtures', 'tickets.sample.json');
  const tickets: SampleTicket[] = JSON.parse(
    readFileSync(fixturePath, 'utf-8'),
  );

  for (const ticket of tickets) {
    const res = await fetch(`${baseUrl}/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ticket),
    });

    if (res.status === 201) {
      console.log(`created   ${ticket.id}`);
    } else if (res.status === 200) {
      console.log(`unchanged ${ticket.id} (already existed)`);
    } else {
      const body = await res.text();
      console.error(`failed    ${ticket.id} -> ${res.status} ${body}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
