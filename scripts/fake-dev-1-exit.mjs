/**
 * 验收探针夹具①：**假 dev —— 起来就退出**。
 * 只在 accept-dev-hot-reload-test.js 的「探针有效性」自查里用：
 * 一个「打印了热加载口号但立刻退出、根本没在监听」的实现必须被判失败。
 * 不是产品的一部分，别拿它当热加载用。
 */
process.stdout.write('[dev] 热加载就绪（dev-ready）\n');
process.stdout.write('[dev] 构建完成 build#1 renderer=yes main=yes\n');
process.stdout.write('[dev] renderer 变了 → 已重编译，窗口已刷新\n');
process.stdout.write('[dev] main 变了 → 已重编译，主进程已重启\n');
setTimeout(() => process.exit(0), 150);
