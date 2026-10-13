/**
 * 纯逻辑：**真正把 AI 请求发出去的那一层（唯一连网的地方）**。**不依赖 Electron**。
 *
 * 为什么单独一个文件：AI 分类的「算」与「发」分开 ——
 *   · `aiAppFiles.ts`：用户设置放在哪儿、怎么读写（密钥只进那个配置文件）；
 *   · `aiClassify.ts`：地址拼接、请求体（只带文件名/大小/修改时间）、解析、对上原文件、分批与重试；
 *   · 本文件：**只负责把字节发出去、把响应收回来**（含超时、状态码翻译、认证头）。
 * 这样一个文件出问题时一眼能看出是「说的不对」还是「发的不好」。
 *
 * 纪律：
 *   · 认证头只在**这里**拼（密钥不落日志、不回显、不进任何文件）；
 *   · 只按 IPv4 解析地址：本机/局域网里的服务常常只有 IPv4，走 IPv6 会白等一轮；
 *   · 超时 / 429 / 5xx 标成「可重试」，别的错（含 400 / 401）一次就停并说清人话；
 *   · 本文件不碰磁盘（读设置是 `aiAppFiles.ts` 的事）。
 */
import * as http from 'http';
import * as https from 'https';
import * as dns from 'dns';
import {
  installAiWire,
  type AiWireGate,
  type AiWireOutcome,
} from './aiClassify';
import { readAiConfigFile } from './aiAppFiles';

/** 超时哨兵：只在「超时」这一种失败上发生，用来把「超时」和别的断开分开。 */
const TIMED_OUT = new Error('ai-request-timed-out');

/** 状态码 → 人话（说清是「密钥不对」还是「服务端出错」这类，能直接给用户看）。 */
export function describeAiStatus(status: number, bodyText: string): string {
  const detail = String(bodyText ?? '').replace(/\s+/g, ' ').slice(0, 160);
  const tail = detail.length > 0 ? `；服务端说：${detail}` : '';
  if (status === 401 || status === 403) return `接口说密钥不对或没权限（HTTP ${status}）${tail}`;
  if (status === 404) return `接口地址不对，找不到这个路径（HTTP 404）${tail}`;
  if (status === 429) return `接口说请求太频繁，被限流了（HTTP 429）${tail}`;
  if (status >= 500) return `接口那边出错了（HTTP ${status}）${tail}`;
  return `接口不接受这次请求（HTTP ${status}）${tail}`;
}

/**
 * 发一次请求（**不含重试**；重试在 `aiClassify.ts` 那边按「可不可重试」决定）。
 * 地址 = 设置里的接口地址 + 路径（如 `/v1/chat/completions`）；认证头在这一处拼。
 */
function callOnce(input: {
  endpoint: string;
  authToken: string;
  path: string;
  body: string;
  timeoutMs: number;
}): Promise<AiWireOutcome> {
  const url = `${String(input?.endpoint ?? '').trim().replace(/\/+$/, '')}${String(input?.path ?? '')}`;
  const timeoutMs = Math.max(1000, Number(input?.timeoutMs) || 60_000);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${String(input?.authToken ?? '')}`,
  };
  const sent = { url, headers: { ...headers }, body: String(input?.body ?? '') };

  return new Promise<AiWireOutcome>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let live: { destroy: (err?: Error) => void } | null = null;

    const finish = (outcome: AiWireOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(outcome);
    };
    const fail = (error: string, retryable: boolean): void => {
      finish({ ok: false, status: 0, body: '', error, retryable, sentRequest: sent });
    };

    let target: URL;
    try {
      target = new URL(url);
    } catch {
      fail(`接口地址不对：「${url}」不是一个能用的地址`, false);
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      fail(`接口地址只能用 http 或 https（现在给的是 ${target.protocol}）`, false);
      return;
    }

    const client = target.protocol === 'https:' ? https : http;
    timer = setTimeout(() => {
      try {
        live?.destroy(TIMED_OUT);
      } catch {
        /* 已经结束了就算了 */
      }
    }, timeoutMs);

    const options: http.RequestOptions = {
      method: 'POST',
      headers,
      timeout: timeoutMs,
      // 只按 IPv4 解析（本机服务常只有 IPv4）
      lookup: (hostname, _opts, callback) => {
        dns.lookup(hostname, { family: 4 }, (err, address, family) =>
          callback(err, address as string, (family ?? 4) as number),
        );
      },
    };

    try {
      const req = client.request(target, options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const status = Number(res.statusCode ?? 0);
          const text = Buffer.concat(chunks).toString('utf8');
          if (status >= 200 && status < 300) {
            finish({ ok: true, status, body: text, error: null, retryable: false, sentRequest: sent });
            return;
          }
          finish({
            ok: false,
            status,
            body: text,
            error: describeAiStatus(status, text),
            retryable: status === 429 || status >= 500,
            sentRequest: sent,
          });
        });
        res.on('error', () => fail('读响应的时候断开了（网络不稳）', true));
      });
      live = req;
      req.on('error', (err: unknown) => {
        if (err === TIMED_OUT) {
          fail(`等了 ${Math.round(timeoutMs / 1000)} 秒还没回话（超时）`, true);
          return;
        }
        const e = err as NodeJS.ErrnoException | undefined;
        fail(`连不上这个接口地址（${e?.code ?? e?.message ?? '网络错误'}）`, true);
      });
      req.write(sent.body);
      req.end();
    } catch (err) {
      fail(`发请求的时候出错：${(err as Error)?.message ?? '未知错误'}`, false);
    }
  });
}

/** 那个门（`aiClassify.ts` 只认这个形状）。 */
const wire: AiWireGate = {
  call: (input) => callOnce(input),
};

/** 装上（本模块被 require 时装一次就够了）。 */
let installed = false;
export function installAiTransport(): void {
  if (installed) return;
  installed = true;
  installAiWire(wire);
}

installAiTransport();

/**
 * 「测试连接」：**只发一次请求，不重试**，看地址 / 密钥 / 模型名能不能通。
 *
 * 两种用法（同一件事）：
 *   · 给一个设置位置（userData 下那份，或验收用的临时那份）→ 先读回来再测；
 *   · 给一份设置对象（界面上刚填、还没保存的那三项）→ 直接拿它测。
 * 不碰磁盘（除了第一种用法里读设置那一次）。
 */
export async function testAiConnection(
  input: { endpoint?: string; model?: string; authToken?: string } | string | null | undefined,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; message: string }> {
  const typed =
    typeof input === 'string'
      ? readAiConfigFile(input)
      : ((input ?? null) as { endpoint?: string; model?: string; authToken?: string } | null);
  const endpoint = String(typed?.endpoint ?? '').trim();
  const authToken = String(typed?.authToken ?? '');
  const model = String(typed?.model ?? '').trim();
  if (endpoint.length === 0) return { ok: false, message: '接口地址是空的，先填一个地址再测' };
  if (authToken.length === 0) return { ok: false, message: '密钥是空的，先填上密钥再测' };
  const body = JSON.stringify({
    model,
    temperature: 0,
    stream: false,
    messages: [
      { role: 'system', content: '这是一个连接测试。' },
      { role: 'user', content: '请只回一个 JSON 对象：{"测试": []}' },
    ],
  });
  const pathSuffix = /\/v1$/i.test(endpoint) ? '/chat/completions' : '/v1/chat/completions';
  const outcome = await callOnce({ endpoint, authToken, path: pathSuffix, body, timeoutMs });
  if (!outcome.ok) return { ok: false, message: `连不上：${outcome.error ?? '未知原因'}` };
  return { ok: true, message: `连接成功：${model || '这个模型'} 回话了` };
}
