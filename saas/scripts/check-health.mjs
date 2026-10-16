// Exit code is suitable for a deployment health monitor. It never sends messages itself.
const url = process.env.SAAS_HEALTH_URL ?? 'http://localhost:3001/health';
const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
const body = await response.json();
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), ...body }));
process.exitCode = response.ok && body.status === 'ok' ? 0 : 1;
