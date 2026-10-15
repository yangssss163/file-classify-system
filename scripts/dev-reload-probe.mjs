/**
 * 开发用「窗口刷新」探针：对着主进程里那个开发用小接口，真的发一次刷新请求。
 *
 * 用途：证明 `npm run dev` 的「窗口自动刷新」不是一句空话 —— 请求真的送到了主进程、
 * 主进程真的调了 `webContents.reloadIgnoringCache()`。
 * 只是这个证明**需要本机能起 Electron**：沙箱环境里 Electron 起不来
 * （install_dir_access.cc:52 / 0x80000003），所以验收第 17 条在沙箱里跳过这一步、
 * 只如实说明；在用户的普通 PowerShell 窗口里它会给出真结果。
 *
 * 用法（先跑 npm run dev，再用这个）：
 *   node scripts/dev-reload-probe.mjs
 *   node scripts/dev-reload-probe.mjs --expect-no-window   # 起不了窗口时也要求「接口活着」
 *
 * 退出码：0 = 接口活着且请求被主进程接受（reloaded 或 no-window 都算接受）；
 *         1 = 接口不可达 / 令牌不对 / 主进程回绝。
 * 结论行（人话）：`dev-reload-probe:OK ...` 或 `dev-reload-probe:FAIL ...`
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateFile = process.env.DSH_DEV_STATE_FILE || path.join(root, 'out', '.dev-state.json');
const expectNoWindow = process.argv.includes('--expect-no-window');

function fail(why) {
  console.log(`dev-reload-probe:FAIL ${why}`);
  process.exit(1);
}

if (!fs.existsSync(stateFile)) {
  fail(`找不到 ${stateFile}（主进程还没把开发用小接口的端口写出来：Electron 没起来，或者是沙箱环境）`);
}

let state = null;
try {
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
} catch (err) {
  fail(`端口文件读不动/不是 JSON：${err.message}`);
}
if (!state || !state.port || !state.token) fail('端口文件里没有 port/token');

function call(method, pathname) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: state.port,
        path: pathname,
        method,
        headers: { authorization: `Bearer ${state.token}`, 'content-length': 0 },
        timeout: 4000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode, body, parsed });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ status: 0, body: err.message, parsed: null }));
    req.end();
  });
}

console.log(`dev-reload-probe: 端口文件 ${stateFile}（端口 ${state.port}，主进程 pid ${state.pid}）`);

const health1 = await call('GET', '/dev-health');
if (health1.status !== 200 || !health1.parsed?.ok) {
  fail(`/dev-health 没有正常回应（HTTP ${health1.status} ${String(health1.body).slice(0, 120)}）`);
}
const reload = await call('POST', '/dev-reload');
console.log(
  `dev-reload-probe: /dev-health -> ${health1.body.trim()} ；/dev-reload -> HTTP ${reload.status} ${String(
    reload.body,
  ).trim()}`,
);
if (reload.status !== 200 || !reload.parsed) {
  fail(`/dev-reload 没有正常回应（HTTP ${reload.status} ${String(reload.body).slice(0, 120)}）`);
}
const action = String(reload.parsed.action);
if (action === 'reloaded') {
  const health2 = await call('GET', '/dev-health');
  console.log(
    `dev-reload-probe: 刷新后再看一次 -> HTTP ${health2.status} ${String(health2.body).trim()}（刷新前窗口数 ${
      health1.parsed.windows
    }）`,
  );
  console.log(
    `dev-reload-probe:OK 主进程接受了刷新请求并把窗口重载了（rendererId=${reload.parsed.rendererId}，窗口数 ${reload.parsed.windows}）`,
  );
  process.exit(0);
}
if (action === 'no-window') {
  if (expectNoWindow) {
    console.log('dev-reload-probe:OK 接口活着且令牌正确，但此刻没有窗口可刷新（no-window，符合预期）');
    process.exit(0);
  }
  fail('接口活着，但主进程说当前没有窗口可刷新（no-window）—— 窗口没起来，没法证明刷新这一半');
}
fail(`主进程回绝了刷新请求：action=${action} body=${String(reload.body).slice(0, 160)}`);
