const API_KEY = process.env.RETELL_API_KEY;
if (!API_KEY) {
  console.error('Set RETELL_API_KEY env var');
  process.exit(1);
}

const [,, agentId, destination] = process.argv;
if (!agentId) {
  console.error('Usage: node trigger.js <agent_id> [phone_number]');
  console.error('  phone_number omitted → creates a web call instead');
  process.exit(1);
}

async function main() {
  const isWebCall = !destination;

  const url = isWebCall
    ? 'https://api.retellai.com/v2/create-web-call'
    : 'https://api.retellai.com/v2/create-phone-call';

  const payload = isWebCall
    ? { agent_id: agentId }
    : { agent_id: agentId, to_number: destination, from_number: undefined };

  if (!isWebCall && !payload.from_number) delete payload.from_number;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();

  if (!res.ok) {
    console.error(`Retell API ${res.status}:`, JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log(isWebCall ? 'Web call created' : 'Phone call created');
  console.log('call_id:', data.call_id);
  if (data.access_token) console.log('access_token:', data.access_token);
  console.log(JSON.stringify(data, null, 2));
}

main();
