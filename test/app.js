// app.js
// Usage:
//   node app.js
//   node app.js --prefix=dotenv_
//   node app.js --all
//   node app.js --json
//
// Examples:
//   dotenv_config_push=... node app.js --prefix=dotenv_
//   node app.js --all --json

function parseArgs(argv) {
  const out = { prefix: "", all: false, json: false, mask: true };
  for (const a of argv.slice(2)) {
    if (a === "--all") out.all = true;
    else if (a === "--json") out.json = true;
    else if (a === "--no-mask") out.mask = false;
    else if (a.startsWith("--prefix=")) out.prefix = a.slice("--prefix=".length);
  }
  return out;
}

function isSensitiveKey(key) {
  return /(token|secret|password|passwd|api[_-]?key|private[_-]?key|auth)/i.test(key);
}

function maskValue(val) {
  if (val == null) return "";
  const s = String(val);
  if (s.length <= 6) return "***";
  return `${s.slice(0, 3)}***${s.slice(-3)}`;
}

function pickEnv({ prefix, all, mask }) {
  const entries = Object.entries(process.env);

  // Mặc định: chỉ show các env do bạn đặt (có prefix), tránh spam CI.
  const filtered = all ? entries : entries.filter(([k]) => (prefix ? k.toLowerCase().startsWith(prefix.toLowerCase()) : true));

  // Sort cho dễ nhìn
  filtered.sort((a, b) => a[0].localeCompare(b[0]));

  const obj = {};
  for (const [k, v] of filtered) {
    const safeVal = mask && isSensitiveKey(k) ? maskValue(v) : String(v ?? "");
    obj[k] = safeVal;
  }
  return obj;
}

function main() {
  const opts = parseArgs(process.argv);
  const envObj = pickEnv(opts);

  if (opts.json) {
    console.log(JSON.stringify(envObj, null, 2));
    return;
  }

  const keys = Object.keys(envObj);
  if (keys.length === 0) {
    console.log("No env matched. Try: node app.js --all OR node app.js --prefix=dotenv_");
    return;
  }

  console.log(`ENV (${keys.length} vars)`);
  for (const k of keys) {
    console.log(`${k}=${envObj[k]}`);
  }
}

main();
