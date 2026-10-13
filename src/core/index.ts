/**
 * 纯逻辑入口：把 core 里的东西集中在这里导出，方便没有界面时用 node 直接 require。
 */
export * from './rules';
export * from './rulesStore';
export * from './classify';
export * from './classifyWithMeta';
export * from './plan';
export * from './copyFiles';
export * from './preview';
export * from './expandAndPlan';
export * from './outputDirection';
export * from './runRecord';
// AI 分类器（真实现）：**整个产品里与 AI 有关的实现只有这四个文件**，各管一段：
//   · `aiAppFiles.ts`  —— 用户设置（接口地址 / 模型名 / 密钥）放在哪儿、怎么读写（密钥只进那个配置文件）；
//   · `aiClassify.ts`  —— 地址拼接、请求体（只带文件名/大小/修改时间）、解析、对上原文件、批次与重试；
//   · `aiRuntime.ts`   —— 少数「跑起来才知道」的事（只读 stat 拿大小/修改时间）；
//   · `aiTransport.ts` —— 真正把请求发出去的那一层（唯一连网的地方），并在载入时把「门」装上。
// 界面/preload 只转调这里导出的东西，不许另写一份。
export * from './aiClassify';
export * from './aiAppFiles';
export * from './aiRuntime';
export * from './aiTransport';
