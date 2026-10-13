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
// AI 分类器：本片只搭壳（接口形状 + 未配置时的人话）。**整个产品里与 AI 有关的实现只有这一个文件**，
// 下一片接真模型时替换它即可；界面/preload 只转调这里导出的东西，不许另写一份。
export * from './aiClassify';
