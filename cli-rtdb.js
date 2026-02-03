#!/usr/bin/env node

/**
 * Triển khai thêm chức năng:
 * - [x]: Bổ sung printHelp(),
 *       + tham số -eUrl=https://xxx.com Url của Realtime database google để lưu các key=value.
 *       + thêm tham số --push: lưu dữ liệu từ path .env lên url (điều kiện, phải có cấu hình -e <path>, và path có tồn tại )
 *       + thêm tham số --pull: lấy dữ liệu từ url, lưu về path .env (điều kiện, phải có cấu hình -e <path>, và path có tồn tại)
 * - [x]: Triển khai thêm rtdbUtils
 * - [x]: Triển khai thêm parseUrlToArgV
 * - [x]: Triển khai executePull và executePush
 */

const spawn = require("cross-spawn");
const path = require("path");
const fs = require("fs");

const argv = require("minimist")(process.argv.slice(2));
const dotenv = require("dotenv");
const dotenvExpand = require("dotenv-expand").expand;

const rtdbUtils = (() => {
  /**
   * Dùng fetch mặc định của NodeJs để xử lý. Nếu có lỗi thì console.error để báo lỗi, không throw lỗi.
   */
  let rtdbUrl = ``;

  const setUrl = (url = "") => (rtdbUrl = url);

  const pushTo = async (objVar = {}) => {
    // Nếu objVar có key, thì sẽ dùng Patch để lưu vào realtime database
    try {
      if (!rtdbUrl) {
        console.error(`[rtdb] Missing url. Provide --eUrl=https://...`);
        return false;
      }
      if (!objVar || typeof objVar !== "object" || Array.isArray(objVar)) {
        console.error(`[rtdb] pushTo expects an object key=value`);
        return false;
      }
      const keys = Object.keys(objVar);
      if (keys.length === 0) return true;

      const res = await fetch(rtdbUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(objVar),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`[rtdb] PATCH failed: HTTP ${res.status} ${res.statusText} ${text ? `- ${text}` : ""}`);
        return false;
      }
      return true;
    } catch (err) {
      console.error(`[rtdb] PATCH error: ${err && err.message ? err.message : err}`);
      return false;
    }
  };

  const envPathPushTo = async (envPath = "") => {
    // Xử lý, chuyển .env bằng path, thành objVar, rồi gọi hàm pushTo
    try {
      const p = `${envPath || ""}`.trim();
      if (!p) {
        console.error(`[rtdb] Missing -e <path> for --push`);
        return false;
      }
      if (!fs.existsSync(p)) {
        console.error(`[rtdb] Env file not found: ${p}`);
        return false;
      }
      const content = fs.readFileSync(p, "utf8");
      const parsed = dotenv.parse(content); // {KEY:VAL}
      return await pushTo(parsed);
    } catch (err) {
      console.error(`[rtdb] envPathPushTo error: ${err && err.message ? err.message : err}`);
      return false;
    }
  };

  const pullFrom = async () => {
    // Lấy dữ liệu từ rtdbUrl, trả về objVar
    try {
      if (!rtdbUrl) {
        console.error(`[rtdb] Missing url. Provide --eUrl=https://...`);
        return {}; //objVar;
      }
      const res = await fetch(rtdbUrl, { method: "GET" });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`[rtdb] GET failed: HTTP ${res.status} ${res.statusText} ${text ? `- ${text}` : ""}`);
        return {};
      }
      const data = await res.json().catch(() => ({}));
      if (!data || typeof data !== "object" || Array.isArray(data)) return {};
      return data;
    } catch (err) {
      console.error(`[rtdb] GET error: ${err && err.message ? err.message : err}`);
      return {};
    }
  };
  /**
   * Helpers
   */
  function ensureEnvPathProvidedAndExists() {
    // Điều kiện: phải có cấu hình -e <path>, và path có tồn tại
    let envPath = "";
    if (argv.e) {
      envPath = typeof argv.e === "string" ? argv.e : argv.e[0];
    }
    envPath = `${envPath || ""}`.trim();
    if (!envPath) {
      console.error(`Missing -e <path>. This is required for --push/--pull.`);
      return { ok: false, envPath: "" };
    }
    if (!fs.existsSync(envPath)) {
      console.error(`Env file does not exist: ${envPath}`);
      return { ok: false, envPath };
    }
    return { ok: true, envPath };
  }

  function serializeEnv(obj = {}) {
    // Serialize obj -> .env lines (simple)
    // - Primitive -> string
    // - Object/Array -> JSON.stringify
    const keys = Object.keys(obj || {}).sort();
    const lines = [];
    for (const k of keys) {
      const v = obj[k];
      let s;
      if (v == null) s = "";
      else if (typeof v === "string") s = v;
      else if (typeof v === "number" || typeof v === "boolean") s = String(v);
      else s = JSON.stringify(v);

      // If contains newline -> JSON stringify as safe string
      if (typeof s === "string" && /[\r\n]/.test(s)) {
        s = JSON.stringify(s);
      }
      lines.push(`${k}=${s}`);
    }
    return lines.join("\n") + (lines.length ? "\n" : "");
  }

  return {
    setUrl,
    pushTo,
    envPathPushTo,
    pullFrom,
    serializeEnv,
    ensureEnvPathProvidedAndExists,
  };
})();

function printHelp() {
  console.log(
    [
      "Usage: dotenv [--help] [--debug] [--quiet=false] [-e <path>] [--eUrl=https://xxx] [--push|--pull] [-v <name>=<value>] [-p <variable name>] [-c [environment]] [--no-expand] [-- command]",
      "  --help              print help",
      "  --debug             output the files that would be processed but don't actually parse them or run the `command`",
      "  --quiet, -q         suppress debug output from dotenv (default: true)",
      "  -e <path>           parses the file <path> as a `.env` file and adds the variables to the environment",
      "  -e <path>           multiple -e flags are allowed",
      "  --eUrl=<url>        Google Firebase Realtime Database URL (REST). Used to pull/push key=value variables (auto append .json if missing)",
      "  --push              push variables from -e <path> .env file up to --eUrl (requires -e exists, and file exists)",
      "  --pull              pull variables from --eUrl and write back to -e <path> .env file (requires -e exists, and file exists)",
      "  -v <name>=<value>   put variable <name> into environment using value <value>",
      "  -v <name>=<value>   multiple -v flags are allowed",
      "  -p <variable>       print value of <variable> to the console. If you specify this, you do not have to specify a `command`",
      "  -c [environment]    support cascading env variables from `.env`, `.env.<environment>`, `.env.local`, `.env.<environment>.local` files",
      "  --no-expand         skip variable expansion",
      "  -o, --override      override system variables. Cannot be used along with cascade (-c).",
      "  command             `command` is the actual command you want to run. Best practice is to precede this command with ` -- `. Everything after `--` is considered to be your command. So any flags will not be parsed by this tool but be passed to your command. If you do not do it, this tool will strip those flags",
    ].join("\n"),
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

async function main() {
  if (argv.help) {
    printHelp();
    process.exit();
  }

  const override = argv.o || argv.override;

  // Handle quiet flag - default is true (quiet), can be disabled with --quiet=false or -q=false
  const isQuiet = !(argv.quiet === false || argv.q === false || argv.quiet === "false" || argv.q === "false");

  if (argv.c && override) {
    console.error("Invalid arguments. Cascading env variables conflicts with overrides.");
    process.exit(1);
  }

  // Setup RTDB URL if provided
  if (argv.eUrl) {
    rtdbUtils.setUrl(argv.eUrl);
  }

  const executePush = async () => {
    /**
     * Nếu tồn tại argv.push, và có url thì thực hiện và trả về true, ngược lại false
     */
    if (!argv.push) return false;
    if (!argv.eUrl) {
      console.error(`Missing --eUrl=<url>. This is required for --push.`);
      return true; // đã "xử lý" case push nhưng lỗi => vẫn kết thúc luồng
    }
    const { ok, envPath } = rtdbUtils.ensureEnvPathProvidedAndExists();
    if (!ok) return true;

    const okPush = await rtdbUtils.envPathPushTo(envPath);
    if (!okPush) process.exit(1);
    return true;
  };

  const executePull = async () => {
    /**
     * Nếu tồn tại argv.pull, và có url thì thực hiện và trả về true, ngược lại false
     */
    if (!argv.pull) return false;
    if (!argv.eUrl) {
      console.error(`Missing --eUrl=<url>. This is required for --pull.`);
      return true; // đã "xử lý" case pull nhưng lỗi => vẫn kết thúc luồng
    }
    const { ok, envPath } = rtdbUtils.ensureEnvPathProvidedAndExists();
    if (!ok) return true;

    const objVar = await rtdbUtils.pullFrom();
    try {
      const out = rtdbUtils.serializeEnv(objVar);
      fs.writeFileSync(envPath, out, "utf8");
    } catch (err) {
      console.error(`[pull] write error: ${err && err.message ? err.message : err}`);
      process.exit(1);
    }
    return true;
  };

  const didPush = await executePush();
  const didPull = await executePull();
  if (didPush === true || didPull === true) {
    // Push/Pull là mode riêng, chạy xong thoát
    process.exit(0);
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
      (accumulator, p) =>
        accumulator.concat(typeof argv.c === "string" ? [`${p}.${argv.c}.local`, `${p}.local`, `${p}.${argv.c}`, p] : [`${p}.local`, p]),
      [],
    );
  }

  const variables = [];
  if (argv.v) {
    if (typeof argv.v === "string") {
      variables.push(validateCmdVariable(argv.v));
    } else {
      variables.push(...argv.v.map(validateCmdVariable));
    }
  }

  const parseUrlToArgV = async () => {
    /**
     * Dùng rtdbUtils để đưa các var từ --eUrl vào variables.
     *    - Phải kiểm tra nếu có truyền --eUrl vào thì mới thực hiện tiếp chỗ này, không có thì không thực thi, kiểm tra bằng cách
     * có giá trị argv.eUrl thì truyền giá trị url này vào  rtdbUtils bằng hàm set để xử lý.
     *    - Nếu có các key, value từ url, thì đưa vào variables
     */
    if (!argv.eUrl) return;
    // url đã được set phía trên, nhưng vẫn giữ đúng tinh thần comment
    rtdbUtils.setUrl(argv.eUrl);

    const objVar = await rtdbUtils.pullFrom();
    if (!objVar || typeof objVar !== "object") return;

    for (const [k, v] of Object.entries(objVar)) {
      if (!k) continue;
      let val;
      if (v == null) val = "";
      else if (typeof v === "string") val = v;
      else if (typeof v === "number" || typeof v === "boolean") val = String(v);
      else val = JSON.stringify(v);

      variables.push([k, val]);
    }
  };

  await parseUrlToArgV();

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
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
