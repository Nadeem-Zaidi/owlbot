// Load test with autocannon.
//   npm run loadtest -- <url> [connections=200] [seconds=20]
//   LOADTEST_TOKEN=<firebase id token> npm run loadtest -- http://localhost:3000/api/load_sessions
// Prints requests/sec, latency percentiles and errors.
const autocannon = require("autocannon");

const [url = "http://localhost:3000/healthz", connections = "200", seconds = "20"] = process.argv.slice(2);
const headers = process.env.LOADTEST_TOKEN ? { authorization: `Bearer ${process.env.LOADTEST_TOKEN}` } : {};

const instance = autocannon({ url, connections: Number(connections), duration: Number(seconds), headers }, (err, r) => {
    if (err) { console.error(err); process.exit(1); }
    const non2xx = r.non2xx ?? 0;
    console.log(`\n${url}  (${connections} connections, ${seconds}s)`);
    console.log(`  requests/sec   avg ${Math.round(r.requests.average)}   max ${r.requests.max}`);
    console.log(`  latency ms     p50 ${r.latency.p50}   p90 ${r.latency.p90}   p99 ${r.latency.p99}   max ${r.latency.max}`);
    console.log(`  total ${r.requests.total}   errors ${r.errors}   timeouts ${r.timeouts}   non-2xx ${non2xx}`);
    const codes = Object.entries(r.statusCodeStats ?? {}).map(([c, v]) => `${c}:${v.count}`).join(" ");
    if (codes) console.log(`  status codes   ${codes}`);
});
autocannon.track(instance, { renderProgressBar: false, renderResultsTable: false, renderLatencyTable: false });
