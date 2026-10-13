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
