// Live check of the NGINX load balancer against the running Docker stack.
// Run: docker compose up -d   then   npm run test:lb   (not part of `npm test`/CI: needs the stack running)
const { execSync } = require('child_process');
const path = require('path');

const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:8080';
const ROOT = path.resolve(__dirname, '../..');   // where docker-compose.yml lives
const BRANCHES = ['ajax', 'oshawa', 'whitby'];

const sh = (cmd) => execSync(cmd, { cwd: ROOT }).toString().trim();
const replicaIds = (branch) => sh(`docker compose ps -q branch-${branch}`).split(/\s+/).filter(Boolean);
const hostnameOf = (containerId) => containerId.slice(0, 12);   // Docker sets hostname = short container id

async function health(branch) {
  const res = await fetch(`${GATEWAY}/${branch}/healthz`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function waitHealthy(containerId, timeoutMs = 45000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (sh(`docker inspect -f "{{.State.Health.Status}}" ${containerId}`) === 'healthy') return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`container ${hostnameOf(containerId)} not healthy after ${timeoutMs}ms`);
}

jest.setTimeout(90000);

test('gateway is up', async () => {
  const res = await fetch(`${GATEWAY}/gateway-health`);
  expect(res.status).toBe(200);
});

test.each(BRANCHES)('%s: requests are spread across every replica', async (branch) => {
  const ids = replicaIds(branch);
  expect(ids.length).toBeGreaterThan(1);   // set replicas/--scale >= 2 or there's nothing to balance

  const seen = new Set();
  for (let i = 0; i < ids.length * 4; i++) {
    const { status, body } = await health(branch);
    expect(status).toBe(200);
    expect(body.branchId).toBe(branch);   // gateway never sends /ajax to another branch
    seen.add(body.instance);
  }
  console.log(`${branch}: ${ids.length} replicas, answered by ${[...seen].join(', ')}`);
  expect(seen).toEqual(new Set(ids.map(hostnameOf)));
});

test.each(BRANCHES)('%s: /internal/* is blocked at the gateway', async (branch) => {
  const res = await fetch(`${GATEWAY}/${branch}/internal/ping-search`);
  expect(res.status).toBe(403);
});

test('ajax: keeps serving 200s when one replica goes down', async () => {
  const [victim, ...rest] = replicaIds('ajax');
  expect(rest.length).toBeGreaterThan(0);

  sh(`docker stop ${victim}`);
  try {
    for (let i = 0; i < 6; i++) {
      const { status, body } = await health('ajax');
      expect(status).toBe(200);
      expect(body.instance).not.toBe(hostnameOf(victim));
    }
  } finally {
    sh(`docker start ${victim}`);   // always put the stack back the way it was
    await waitHealthy(victim);
  }
});
