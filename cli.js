#!/usr/bin/env node

const spawn = require("cross-spawn");
const path = require("path");
const https = require("https");
const http = require("http");
const fs = require("fs");

const argv = require("minimist")(process.argv.slice(2));
const dotenv = require("dotenv");
const dotenvExpand = require("dotenv-expand").expand;

function printHelp() {
  console.log(
    [
      "Usage: dotenv [--help] [--debug] [--quiet=false] [-e <path>] [-v <name>=<value>] [-p <variable name>] [-c [environment]] [--no-expand] [-- command]",
      "  --help              print help",
      "  --debug             output the files that would be processed but don't actually parse them or run the `command`",
      "  --quiet, -q         suppress debug output from dotenv (default: true)",
      "  -e <path>           parses the file <path> as a `.env` file and adds the variables to the environment",
      "  -e <path>           multiple -e flags are allowed",
      "  -v <name>=<value>   put variable <name> into environment using value <value>",
      "  -v <name>=<value>   multiple -v flags are allowed",
      "  -p <variable>       print value of <variable> to the console. If you specify this, you do not have to specify a `command`",
      "  -c [environment]    support cascading env variables from `.env`, `.env.<environment>`, `.env.local`, `.env.<environment>.local` files",
      "  --no-expand         skip variable expansion",
      "  -o, --override      override system variables. Cannot be used along with cascade (-c).",
      "  command             `command` is the actual command you want to run. Best practice is to precede this command with ` -- `. Everything after `--` is considered to be your command. So any flags will not be parsed by this tool but be passed to your command. If you do not do it, this tool will strip those flags",
      "",
      "Remote database commands:",
      "  --pull <url>        pull env variables from remote realtime database URL and save to file",
      "                      use with -e flag to specify output file (default: .env)",
      "                      example: dotenv --pull <url> -e .env.production",
      "  --push <url>        push local .env file to remote realtime database URL",
      "                      use with -e flag to specify source file (default: .env)",
      "                      example: dotenv --push <url> -e .env.staging",
    ].join("\n"),
  );
}

// Hàm mask URL để ẩn auth token
function maskUrl(url) {
  try {
    const urlObj = new URL(url);

    // Mask query parameters chứa auth/token/key
    const params = new URLSearchParams(urlObj.search);
    const maskedParams = new URLSearchParams();

    for (const [key, value] of params.entries()) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes("auth") || lowerKey.includes("token") || lowerKey.includes("key") || lowerKey.includes("secret")) {
        maskedParams.set(key, "******");
      } else {
        maskedParams.set(key, value);
      }
    }

    urlObj.search = maskedParams.toString();

    // Mask username/password trong URL
    if (urlObj.username || urlObj.password) {
      urlObj.username = urlObj.username ? "******" : "";
      urlObj.password = urlObj.password ? "******" : "";
    }

    return urlObj.toString();
  } catch (err) {
    // Nếu không parse được URL, mask theo pattern
    return url.replace(/([?&])(auth|token|key|secret|apikey|api_key)=([^&]+)/gi, "$1$2=******").replace(/\/\/([^:]+):([^@]+)@/gi, "//******:******@");
  }
}

// Hàm fetch dữ liệu từ URL
function fetchFromUrl(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;

    protocol
      .get(url, (res) => {
        let data = "";

        if (res.statusCode !== 200) {
          reject(new Error(`Failed to fetch from ${maskUrl(url)}. Status code: ${res.statusCode}`));
          return;
        }

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          try {
            const jsonData = JSON.parse(data);
            resolve(jsonData);
          } catch (err) {
            reject(new Error(`Failed to parse JSON from ${maskUrl(url)}: ${err.message}`));
          }
        });
      })
      .on("error", (err) => {
        reject(new Error(`Failed to fetch from ${maskUrl(url)}: ${err.message}`));
      });
  });
}

// Hàm push dữ liệu lên URL (PUT request for Firebase Realtime Database)
function pushToUrl(url, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = url.startsWith("https") ? https : http;

    const jsonData = JSON.stringify(data);

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(jsonData),
      },
    };

    const req = protocol.request(options, (res) => {
      let responseData = "";

      res.on("data", (chunk) => {
        responseData += chunk;
      });

      res.on("end", () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          resolve(responseData);
        } else {
          reject(new Error(`Failed to push to ${maskUrl(url)}. Status code: ${res.statusCode}`));
        }
      });
    });

    req.on("error", (err) => {
      reject(new Error(`Failed to push to ${maskUrl(url)}: ${err.message}`));
    });

    req.write(jsonData);
    req.end();
  });
}

// Hàm chuyển đổi object thành format .env
function objectToEnvFormat(obj) {
  if (!obj || typeof obj !== "object") {
    return "";
  }

  return Object.entries(obj)
    .map(([key, value]) => {
      // Escape giá trị nếu chứa ký tự đặc biệt
      const stringValue = String(value);
      if (stringValue.includes("\n") || stringValue.includes('"') || stringValue.includes(" ")) {
        return `${key}="${stringValue.replace(/"/g, '\\"')}"`;
      }
      return `${key}=${stringValue}`;
    })
    .join("\n");
}

// Hàm đọc file .env và chuyển thành object
function parseEnvFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const result = {};

    for (const line of lines) {
      const trimmedLine = line.trim();

      // Bỏ qua comment và dòng trống
      if (!trimmedLine || trimmedLine.startsWith("#")) {
        continue;
      }

      // Parse key=value
      const match = trimmedLine.match(/^([^=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        let value = match[2].trim();

        // Xử lý giá trị trong dấu ngoặc kép
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1).replace(/\\"/g, '"');
        } else if (value.startsWith("'") && value.endsWith("'")) {
          value = value.slice(1, -1);
        }

        result[key] = value;
      }
    }

    return result;
  } catch (err) {
    throw new Error(`Failed to read or parse ${filePath}: ${err.message}`);
  }
}

// Xử lý lệnh pull
async function handlePull(url, outputPath) {
  try {
    console.log(`Pulling environment variables from ${maskUrl(url)}...`);
    const data = await fetchFromUrl(url);
    const envContent = objectToEnvFormat(data);

    fs.writeFileSync(outputPath, envContent, "utf-8");
    console.log(`✓ Successfully pulled environment variables to ${outputPath}`);
    process.exit(0);
  } catch (err) {
    console.error(`✗ Pull failed: ${err.message}`);
    process.exit(1);
  }
}

// Xử lý lệnh push
async function handlePush(url, sourcePath) {
  try {
    console.log(`Pushing environment variables from ${sourcePath} to ${maskUrl(url)}...`);

    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Source file ${sourcePath} does not exist`);
    }

    const envData = parseEnvFile(sourcePath);
    await pushToUrl(url, envData);

    console.log(`✓ Successfully pushed environment variables to ${maskUrl(url)}`);
    process.exit(0);
  } catch (err) {
    console.error(`✗ Push failed: ${err.message}`);
    process.exit(1);
  }
}

if (argv.help) {
  printHelp();
  process.exit();
}

// Xử lý lệnh pull - sử dụng -e flag để chỉ định output file
if (argv.pull) {
  const pullUrl = argv.pull;
  // Nếu có -e flag, dùng file đầu tiên, nếu không dùng .env
  let outputPath = ".env";
  if (argv.e) {
    outputPath = typeof argv.e === "string" ? argv.e : argv.e[0];
  }
  handlePull(pullUrl, outputPath);
  return;
}

// Xử lý lệnh push - sử dụng -e flag để chỉ định source file
if (argv.push) {
  const pushUrl = argv.push;
  // Nếu có -e flag, dùng file đầu tiên, nếu không dùng .env
  let sourcePath = ".env";
  if (argv.e) {
    sourcePath = typeof argv.e === "string" ? argv.e : argv.e[0];
  }
  handlePush(pushUrl, sourcePath);
  return;
}

// ===== PHẦN CODE GỐC BÊN DƯỚI GIỮ NGUYÊN =====

const override = argv.o || argv.override;

// Handle quiet flag - default is true (quiet), can be disabled with --quiet=false or -q=false
const isQuiet = !(argv.quiet === false || argv.q === false || argv.quiet === "false" || argv.q === "false");

if (argv.c && override) {
  console.error("Invalid arguments. Cascading env variables conflicts with overrides.");
  process.exit(1);
}

let paths = [];
if (argv.e) {
  if (typeof argv.e === "string") {
    paths.push(argv.e);
  } else {
    paths.push(...argv.e);
  }
} else {
  paths.push(".env");
}

if (argv.c) {
  paths = paths.reduce(
    (accumulator, path) =>
      accumulator.concat(
        typeof argv.c === "string" ? [`${path}.${argv.c}.local`, `${path}.local`, `${path}.${argv.c}`, path] : [`${path}.local`, path],
      ),
    [],
  );
}

function validateCmdVariable(param) {
  const [, key, val] = param.match(/^(\w+)=([\s\S]+)$/m) || [];
  if (!key || !val) {
    console.error(`Invalid variable name. Expected variable in format '-v variable=value', but got: \`-v ${param}\`.`);
    process.exit(1);
  }

  return [key, val];
}
const variables = [];
if (argv.v) {
  if (typeof argv.v === "string") {
    variables.push(validateCmdVariable(argv.v));
  } else {
    variables.push(...argv.v.map(validateCmdVariable));
  }
}
const parsedVariables = Object.fromEntries(variables);

if (argv.debug) {
  console.log(paths);
  console.log(parsedVariables);
  process.exit();
}

paths.forEach(function (env) {
  dotenv.config({ path: path.resolve(env), override, quiet: isQuiet });
});

// Expand when all path configs are loaded
if (argv.expand !== false) {
  dotenvExpand({
    parsed: process.env,
  });
}
Object.assign(process.env, parsedVariables);

if (argv.p) {
  let value = process.env[argv.p];
  if (typeof value === "string") {
    value = `${value}`;
  }
  console.log(value != null ? value : "");
  process.exit();
}

const command = argv._[0];
if (!command) {
  printHelp();
  process.exit(1);
}

const child = spawn(command, argv._.slice(1), { stdio: "inherit" }).on("exit", function (exitCode, signal) {
  if (typeof exitCode === "number") {
    process.exit(exitCode);
  } else {
    process.kill(process.pid, signal);
  }
});

for (const signal of ["SIGINT", "SIGTERM", "SIGPIPE", "SIGHUP", "SIGBREAK", "SIGWINCH", "SIGUSR1", "SIGUSR2"]) {
  process.on(signal, function () {
    child.kill(signal);
  });
}
