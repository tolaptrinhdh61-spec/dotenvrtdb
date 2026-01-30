#!/usr/bin/env node

const spawn = require("cross-spawn");
const path = require("path");
const https = require("https");
const http = require("http");
const fs = require("fs");
const os = require("os");

// ✅ FIX: Custom parsing để handle URLs bị split bởi shell hoặc masked bởi GitHub Actions
// Case 1: URL không có quotes, shell tách thành nhiều args
//   VD: -eUrl https://example.com?auth=123&key=456
//   Shell tách: ['-eUrl', 'https://example.com?auth=123', 'key=456']
//   → Ghép lại: ['-eUrl', 'https://example.com?auth=123&key=456']
//
// Case 2: GitHub Actions mask secret thành ***, không có quotes
//   VD: -eUrl *** -- node script.js
//   GitHub mask trước: ['-eUrl', '***', '--', 'node', 'script.js']
//   → Giữ nguyên '***' và tìm '--' để tách command
function parseArguments(args) {
  const result = [];
  let i = 0;

  // Tìm vị trí của '--' trước tiên
  const doubleDashIndex = args.indexOf("--");

  while (i < args.length) {
    const arg = args[i];

    // Nếu gặp '--', dừng parsing flags và pass everything sau đó as command
    if (arg === "--") {
      // Không push '--' vào result, nhưng push tất cả args sau nó
      i++;
      while (i < args.length) {
        result.push(args[i]);
        i++;
      }
      break;
    }

    // Nếu là -eUrl, cần xử lý đặc biệt
    if (arg === "-eUrl" || arg === "--eUrl") {
      result.push(arg);
      i++;

      // Ghép tất cả args tiếp theo cho đến khi gặp '--' hoặc arg bắt đầu bằng '-'
      let urlParts = [];
      while (i < args.length && args[i] !== "--") {
        const nextArg = args[i];

        // Nếu gặp flag khác (bắt đầu với '-' nhưng KHÔNG phải '***' hoặc pattern giống)
        // thì dừng lại
        if (nextArg.startsWith("-") && !nextArg.match(/^-[\*\+\.]+$/)) {
          break;
        }

        urlParts.push(nextArg);
        i++;
      }

      // Ghép lại thành 1 URL với '&' (trường hợp shell tách bởi &)
      // Hoặc giữ nguyên nếu là masked value như '***'
      if (urlParts.length > 0) {
        result.push(urlParts.join("&"));
      }
    } else {
      result.push(arg);
      i++;
    }
  }

  return result;
}

const parsedArgs = parseArguments(process.argv.slice(2));
const argv = require("minimist")(parsedArgs);
const dotenv = require("dotenv");

// ✅ FIX: Xử lý import dotenv-expand cho cả CommonJS và ES modules
let dotenvExpand;
try {
  // Thử import theo cách mới (dotenv-expand >= 9.0)
  const dotenvExpandModule = require("dotenv-expand");
  dotenvExpand = dotenvExpandModule.expand || dotenvExpandModule.default || dotenvExpandModule;
} catch (err) {
  console.error("Failed to load dotenv-expand:", err.message);
  process.exit(1);
}

// Biến lưu danh sách các file tạm cần xóa
const tempFilesToCleanup = [];
let isCleanedUp = false; // Prevent double cleanup

function printHelp() {
  console.log(
    [
      "Usage: dotenvrtdb [--help] [--debug] [--quiet=false] [-e <path>] [-eUrl <url>] [-v <n>=<value>] [-p <variable name>] [-c [environment]] [--no-expand] [-- command]",
      "  --help              print help",
      "  --debug             output the files that would be processed but don't actually parse them or run the `command`",
      "  --quiet, -q         suppress debug output from dotenv (default: true)",
      "  -e <path>           parses the file <path> as a `.env` file and adds the variables to the environment",
      "  -e <path>           multiple -e flags are allowed",
      "  -eUrl <url>         pull env from remote URL to temp file, use it, then delete temp file",
      "  -eUrl <url>         multiple -eUrl flags are allowed",
      "  -v <n>=<value>      put variable <n> into environment using value <value>",
      "  -v <n>=<value>      multiple -v flags are allowed",
      "  -p <variable>       print value of <variable> to the console. If you specify this, you do not have to specify a `command`",
      "  -c [environment]    support cascading env variables from `.env`, `.env.<environment>`, `.env.local`, `.env.<environment>.local` files",
      "  --no-expand         skip variable expansion",
      "  -o, --override      override system variables. Cannot be used along with cascade (-c).",
      "  command             `command` is the actual command you want to run. Best practice is to precede this command with ` -- `. Everything after `--` is considered to be your command. So any flags will not be parsed by this tool but be passed to your command. If you do not do it, this tool will strip those flags",
      "",
      "Remote database commands:",
      "  --pull <url>        pull env variables from remote database URL and save to file",
      "                      use with -e flag to specify output file (default: .env)",
      "                      example: dotenvrtdb --pull <url> -e .env.production",
      "  --push <url>        push local .env file to remote database URL",
      "                      use with -e flag to specify source file (default: .env)",
      "                      example: dotenvrtdb --push <url> -e .env.staging",
    ].join("\n"),
  );
}

// Hàm cleanup để xóa các file tạm
function cleanupTempFiles() {
  if (isCleanedUp) return;
  isCleanedUp = true;

  if (tempFilesToCleanup.length === 0) {
    return; // Không có file tạm nào để xóa
  }

  const isDebug = argv.debug;
  const isQuiet = !(argv.quiet === false || argv.q === false || argv.quiet === "false" || argv.q === "false");

  // 🔒 ALWAYS show cleanup message for security awareness
  if (!isQuiet) {
    console.log(`\n🧹 Cleaning up ${tempFilesToCleanup.length} temporary file(s)...`);
  }

  let deletedCount = 0;
  let failedCount = 0;

  tempFilesToCleanup.forEach((filePath) => {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deletedCount++;
        if (isDebug || !isQuiet) {
          console.log(`   ✓ Deleted: ${path.basename(filePath)}`);
        }
      } else {
        if (isDebug) {
          console.log(`   ⊘ Already deleted: ${path.basename(filePath)}`);
        }
      }
    } catch (err) {
      failedCount++;
      console.error(`   ✗ Failed to delete ${path.basename(filePath)}: ${err.message}`);
    }
  });

  if (!isQuiet && deletedCount > 0) {
    console.log(`✓ Successfully deleted ${deletedCount} temporary file(s)\n`);
  }

  if (failedCount > 0) {
    console.error(`⚠️  Warning: ${failedCount} file(s) could not be deleted. Please check manually.`);
  }
}

// Đăng ký cleanup khi process kết thúc
process.on("exit", cleanupTempFiles);
process.on("SIGINT", () => {
  cleanupTempFiles();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanupTempFiles();
  process.exit(143);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  cleanupTempFiles();
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
  cleanupTempFiles();
  process.exit(1);
});

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

// Hàm tạo file tạm từ URL
async function createTempFileFromUrl(url, index = 0) {
  const isDebug = argv.debug;
  const isQuiet = !(argv.quiet === false || argv.q === false || argv.quiet === "false" || argv.q === "false");
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(7);
  const tempFileName = `.env.temp.${timestamp}.${index}.${randomSuffix}`;

  // 🔒 CRITICAL SECURITY FIX: Tạo temp file trong OS temp directory
  // KHÔNG tạo trong cwd để tránh:
  // 1. File bị commit vào git
  // 2. File bị publish lên npm package
  // 3. Secrets bị leak ra public
  const tempFilePath = path.join(os.tmpdir(), tempFileName);

  try {
    if (isDebug || !isQuiet) {
      console.log(`📥 Fetching env vars from ${maskUrl(url)}...`);
    }

    const data = await fetchFromUrl(url);
    const envContent = objectToEnvFormat(data);

    fs.writeFileSync(tempFilePath, envContent, "utf-8");

    if (isDebug || !isQuiet) {
      console.log(`   ✓ Created temp file: ${tempFileName}`);
      console.log(`   📍 Location: ${os.tmpdir()}`);
      console.log(`   🔒 Will be auto-deleted after execution`);
    }

    // Thêm vào danh sách cần cleanup
    tempFilesToCleanup.push(tempFilePath);

    return tempFilePath;
  } catch (err) {
    throw new Error(`Failed to create temp file from ${maskUrl(url)}: ${err.message}`);
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

// Xử lý -eUrl: Pull từ URL vào file tạm
async function processEUrlFlags() {
  // ✅ FIX: Support reading URL from environment variable
  // Nếu -eUrl = "***" (GitHub Actions masked), thử đọc từ env var
  // Priority: 1) argv.eUrl nếu không phải "***", 2) DOTENVRTDB_URL env var

  let urls = [];

  if (argv.eUrl) {
    let eUrlValue = typeof argv.eUrl === "string" ? [argv.eUrl] : argv.eUrl;

    if (!Array.isArray(eUrlValue)) {
      eUrlValue = [eUrlValue];
    }

    // Check if URL is masked by GitHub Actions
    urls = eUrlValue.map((url) => {
      if (url === "***" || url === "*" || url.match(/^\*+$/)) {
        // URL was masked, try to get from environment variable
        const envUrl = process.env.DOTENVRTDB_URL;
        if (envUrl) {
          console.log("⚠️  Detected masked URL (***), using DOTENVRTDB_URL environment variable");
          return envUrl;
        } else {
          console.error("❌ URL was masked by GitHub Actions but DOTENVRTDB_URL env var not found");
          console.error("   Please set DOTENVRTDB_URL as environment variable:");
          console.error("   env:");
          console.error("     DOTENVRTDB_URL: ${{ secrets.DOTENVRTDB_URL }}");
          process.exit(1);
        }
      }
      return url;
    });
  } else if (process.env.DOTENVRTDB_URL) {
    // Không có -eUrl flag nhưng có env var
    urls = [process.env.DOTENVRTDB_URL];
    console.log("ℹ️  Using DOTENVRTDB_URL from environment variable");
  } else {
    return [];
  }

  urls = urls.filter((url) => url && typeof url === "string" && url.trim().length > 0);

  if (urls.length === 0) {
    return [];
  }

  const tempPaths = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const tempPath = await createTempFileFromUrl(url, i);
      tempPaths.push(tempPath);
    } catch (err) {
      console.error(`✗ Failed to process -eUrl ${maskUrl(url)}: ${err.message}`);
      cleanupTempFiles();
      process.exit(1);
    }
  }

  return tempPaths;
}

// Main async function để xử lý -eUrl
async function main() {
  const override = argv.o || argv.override;

  // Handle quiet flag - default is true (quiet), can be disabled with --quiet=false or -q=false
  const isQuiet = !(argv.quiet === false || argv.q === false || argv.quiet === "false" || argv.q === "false");

  if (argv.c && override) {
    console.error("Invalid arguments. Cascading env variables conflicts with overrides.");
    process.exit(1);
  }

  let paths = [];

  // Xử lý -eUrl trước
  const tempPaths = await processEUrlFlags();

  if (Array.isArray(tempPaths) && tempPaths.length > 0) {
    paths.push(...tempPaths);
  }

  // Sau đó xử lý -e như bình thường
  if (argv.e) {
    if (typeof argv.e === "string") {
      paths.push(argv.e);
    } else if (Array.isArray(argv.e)) {
      paths.push(...argv.e);
    }
  }

  // Nếu không có -e và -eUrl, dùng .env mặc định
  if (paths.length === 0) {
    paths.push(".env");
  }

  if (argv.c) {
    paths = paths.reduce(
      (accumulator, envPath) =>
        accumulator.concat(
          typeof argv.c === "string"
            ? [`${envPath}.${argv.c}.local`, `${envPath}.local`, `${envPath}.${argv.c}`, envPath]
            : [`${envPath}.local`, envPath],
        ),
      [],
    );
  }

  function validateCmdVariable(param) {
    const [, key, val] = param.match(/^(\w+)=([\s\S]+)$/m) || [];
    if (!key || !val) {
      console.error(`Invalid variable name. Expected variable in format '-v variable=value', but got: \`-v ${param}\`.`);
      cleanupTempFiles();
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
    console.log("Files to be processed:");
    console.log(paths);
    console.log("\nVariables from command line:");
    console.log(parsedVariables);
    if (tempFilesToCleanup.length > 0) {
      console.log("\nTemp files (will be deleted after execution):");
      console.log(tempFilesToCleanup);
    }
    cleanupTempFiles();
    process.exit();
  }

  // ✅ FIX: Load và expand từng file với kiểm tra function
  paths.forEach(function (env) {
    const resolvedPath = path.resolve(env);

    // Debug: Check if file exists
    if (!fs.existsSync(resolvedPath)) {
      if (!isQuiet) {
        console.warn(`Warning: File does not exist: ${resolvedPath}`);
      }
      return; // Skip this file
    }

    const result = dotenv.config({ path: resolvedPath, override, quiet: isQuiet });

    // Debug: Check if file was loaded successfully
    if (result.error && !isQuiet) {
      console.error(`Error loading ${resolvedPath}:`, result.error.message);
    } else if (result.parsed && !isQuiet) {
      console.log(`✓ Loaded ${Object.keys(result.parsed).length} variables from ${resolvedPath}`);
    }

    // Expand variables nếu cần và nếu dotenvExpand là function
    if (argv.expand !== false && result.parsed && typeof dotenvExpand === "function") {
      dotenvExpand(result);
    }
  });

  // Thêm variables từ command line
  Object.assign(process.env, parsedVariables);

  if (argv.p) {
    let value = process.env[argv.p];
    if (typeof value === "string") {
      value = `${value}`;
    }
    console.log(value != null ? value : "");
    cleanupTempFiles();
    process.exit();
  }

  const command = argv._[0];

  // ✅ FIX: Nếu không có command nhưng có -eUrl hợp lệ
  // GitHub Actions có thể mask secret thành *** khiến parsing bị lỗi
  // Trong trường hợp này, check xem có remaining args sau khi parse không
  if (!command && argv.eUrl) {
    console.error("ERROR: No command provided after arguments.");
    console.error("When using -eUrl, make sure to include the command to run.");
    console.error("");
    console.error("Examples:");
    console.error('  dotenvrtdb -eUrl "${{ secrets.URL }}" -- node script.js');
    console.error('  dotenvrtdb -eUrl "https://example.com" -- npm start');
    console.error("");
    console.error("Note: In GitHub Actions, always quote secrets to prevent parsing issues:");
    console.error('  -eUrl "${{ secrets.DOTENVRTDB_URL }}" -- command');
    console.error("");
    printHelp();
    cleanupTempFiles();
    process.exit(1);
  }

  if (!command) {
    printHelp();
    cleanupTempFiles();
    process.exit(1);
  }

  const child = spawn(command, argv._.slice(1), { stdio: "inherit" }).on("exit", function (exitCode, signal) {
    cleanupTempFiles();
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
}

// Entry point
(async function () {
  // ✅ DEBUG: Always log raw arguments để diagnose vấn đề
  const hasEUrl = process.argv.includes("-eUrl") || process.argv.includes("--eUrl");
  const hasDoubleDash = process.argv.includes("--");
  const hasCommand = argv._.length > 0;

  // Nếu có -eUrl nhưng không có command, có thể là parsing issue
  if (hasEUrl && !hasCommand && !argv.help && !argv.pull && !argv.push && !argv.debug && !argv.p) {
    console.error("=== ARGUMENT PARSING DEBUG ===");
    console.error("Raw process.argv:", process.argv);
    console.error("Parsed args:", parsedArgs);
    console.error("Minimist result:", JSON.stringify(argv, null, 2));
    console.error("Has --:", hasDoubleDash);
    console.error("==============================");
    console.error("");
    console.error("ERROR: No command provided after arguments");
    console.error("");
    console.error("The most common cause is forgetting '--' before the command:");
    console.error("  ❌ Wrong:   dotenvrtdb -eUrl ${{ secrets.URL }} node script.js");
    console.error('  ✅ Correct: dotenvrtdb -eUrl "${{ secrets.URL }}" -- node script.js');
    console.error("");
    console.error("In GitHub Actions, ALWAYS quote secrets and use '--':");
    console.error('  run: dotenvrtdb -eUrl "${{ secrets.DOTENVRTDB_URL }}" -- node ./bin/cli.js publish');
    console.error("");
    printHelp();
    process.exit(1);
  }

  // DEBUG MODE
  const isDebugMode = argv.debug || process.env.DEBUG_DOTENVRTDB === "true";
  if (isDebugMode) {
    console.log("=== DEBUG MODE ===");
    console.log("Raw process.argv:", process.argv);
    console.log("Parsed args:", parsedArgs);
    console.log("Minimist argv:", JSON.stringify(argv, null, 2));
    console.log("==================");
  }

  if (argv.help) {
    printHelp();
    process.exit();
  }

  // Xử lý lệnh pull
  if (argv.pull) {
    const pullUrl = argv.pull;
    let outputPath = ".env";
    if (argv.e) {
      outputPath = typeof argv.e === "string" ? argv.e : argv.e[0];
    }
    await handlePull(pullUrl, outputPath);
    return;
  }

  // Xử lý lệnh push
  if (argv.push) {
    const pushUrl = argv.push;
    let sourcePath = ".env";
    if (argv.e) {
      sourcePath = typeof argv.e === "string" ? argv.e : argv.e[0];
    }
    await handlePush(pushUrl, sourcePath);
    return;
  }

  // Chạy main function
  await main();
})().catch((err) => {
  console.error("Fatal error:", err.message);
  console.error(err.stack);
  cleanupTempFiles();
  process.exit(1);
});
