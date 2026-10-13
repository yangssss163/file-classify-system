/**
 * 纯逻辑：**AI 接口的用户设置**（接口地址 / 模型名 / 凭据）的存放与读写。**不依赖 Electron**。
 *
 * 三件事，别的什么都不做：
 *   1. 默认值（DeepSeek：`https://api.deepseek.com`、`deepseek-chat`）—— **只是默认值，用户可改**；
 *   2. 从**本机配置文件**里读设置、把设置写进那个配置文件（文件位置由调用方给，通常是 userData 下的
 *      `organizer-ai.json`）；文件不存在 / 读不了 / 内容坏掉 → 一律「没配置」，绝不抛异常；
 *   3. 界面上必须照抄的那两句提醒（密钥是明文存在本机配置文件里的；只发文件名/大小/修改时间）。
 *
 * 纪律：
 *   · 凭据**只进这个配置文件**：不写进项目目录、不进日志、不回显给界面；
 *   · 本模块**不联网**（连着网的那一层在 `aiTransport.ts`）、**不碰任何用户文件**（只碰这一个配置文件）；
 *   · 界面上要显示的那句话只有这一个来源，别处不许再写一份。
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  installAiConfigTextReader,
  loadAiConfig as loadConfigText,
  type AiConfigTextReader,
} from './aiClassify';

/**
 * AI 设置（存在本机配置文件里的形状）。
 *
 * `authToken` 就是用户自己填的密钥：**明文存在本机配置文件里**（userData 下的 `organizer-ai.json`），
 * 不上传别处、不进代码仓库。除了拼一个认证头那一处（在 `aiTransport.ts` 里），
 * 别处不许把它写出去（不写日志、不回显、不落进项目文件）。
 */
export interface AiConfigEntry {
  /** 接口地址（默认 DeepSeek；用户可在设置里改成别的 OpenAI 兼容地址） */
  endpoint: string;
  /** 模型名（默认 `deepseek-chat`） */
  model: string;
  /** 密钥（明文存在本机配置文件里；不写进项目目录、不进日志） */
  authToken: string;
}

/** 把「按位置取配置文件原文」这件事接给 `aiClassify.ts` 那一层（它那边不碰磁盘）。 */
const configTextReader: AiConfigTextReader = {
  read: (configPath: string) => {
    try {
      return fs.readFileSync(String(configPath), 'utf8');
    } catch {
      return '';
    }
  },
};

installAiConfigTextReader(configTextReader);

/** 默认接口地址（DeepSeek，走 OpenAI 兼容形状）。 */
export const AI_DEFAULT_ENDPOINT = 'https://api.deepseek.com';

/** 默认模型名（DeepSeek 的通用对话模型）。 */
export const AI_DEFAULT_MODEL = 'deepseek-chat';

/** 配置文件的名字（放在 Electron 的 userData 目录下；**不进项目目录**）。 */
export const AI_CONFIG_FILE_NAME = 'organizer-ai.json';

/** 界面上必须写明的那句话：凭据存在哪儿、别提交进仓库。 */
export const AI_CONFIG_KEY_WARNING =
  '密钥是明文存在这台电脑的配置文件里的，不会上传到别处，也请不要提交进代码仓库。';

/** 界面上必须写明的那句话：AI 只能看到这三样。 */
export const AI_METADATA_ONLY_WARNING =
  '只把文件名、大小、修改时间发给模型：不读文件内容、不发文件内容，也不发文件所在目录。';

/**
 * AI 设置（存在本机配置文件里）。
 *
 * `authToken` 就是用户自己填的密钥：**明文存在本机配置文件里**（userData 下的 `organizer-ai.json`），
 * 不上传别处、不进代码仓库。除了拼一个认证头那一处（在 `aiTransport.ts` 里），
 * 别处不许把它写出去（不写日志、不回显、不落进项目文件）。
 *
 * 形状定义在 `aiClassify.ts` 里（那里是「一份设置长什么样」的唯一来源），这里只重导出。
 */

/** 建一份默认设置（用户在设置里改之前就是它）。 */
export function defaultAiConfig(): AiConfigEntry {
  return { endpoint: AI_DEFAULT_ENDPOINT, model: AI_DEFAULT_MODEL, authToken: '' };
}

/** 把任意来源的形状收成一份干净的设置（缺项落默认值，两端空白去掉）。 */
export function normalizeAiConfig(raw: unknown): AiConfigEntry {
  const src = (raw ?? {}) as Partial<AiConfigEntry>;
  const pick = (value: unknown, fallback: string): string => {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.length > 0 ? text : fallback;
  };
  return {
    endpoint: pick(src.endpoint, AI_DEFAULT_ENDPOINT),
    model: pick(src.model, AI_DEFAULT_MODEL),
    authToken: typeof src.authToken === 'string' ? src.authToken.trim() : '',
  };
}

/**
 * 读设置（**整个产品里只有这一处按位置读设置**）。
 *
 * @param configPath 配置文件的位置（由调用方算好传进来）。
 *   **不给位置就返回 null（= 没配置）**：本模块不猜路径、不从别处摸设置。
 *   文件不存在 / 读不了 / 内容坏掉 / 缺密钥 → 一律返回 null，绝不抛异常。
 *   「一份设置算不算配好了」由 `aiClassify.ts` 那一处说了算（这里只负责把原文取回来）。
 */
export function readAiConfigFile(configPath?: string): AiConfigEntry | null {
  return loadConfigText(configPath);
}

/**
 * 把设置写进配置文件（**只有这一处会写 AI 设置**）。
 * 目录不存在就建；写不进去就如实回 `ok:false` + 人话（不抛）。
 */
export function saveAiConfig(configPath: string, config: Partial<AiConfigEntry>): { ok: boolean; message: string } {
  const target = typeof configPath === 'string' ? configPath.trim() : '';
  if (target.length === 0) return { ok: false, message: '没有拿到配置文件的存放位置，这次没保存' };
  const clean = normalizeAiConfig(config);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
    return { ok: true, message: 'AI 设置已保存到本机配置文件，下次打开自动读回' };
  } catch (err) {
    return { ok: false, message: `AI 设置没保存成功：${(err as Error)?.message ?? '未知错误'}` };
  }
}
