// 群日报 feature：把「注册任务 + 排下一次」从 bridge.js 主流程移到这里。
// 业务实现仍在桥接注入的 dailyReport 服务里，feature 只负责生命周期与权限声明。

export default {
  id: 'daily-report',
  name: '群日报',
  version: 1,
  description: '每天固定时间把群聊统计发到群里（默认关闭，按群开启）',
  permissions: ['state:read', 'jobs:write', 'qq:send', 'service:daily-report'],
  hooks: {},
  setup(ctx) {
    if (!ctx.jobs?.register) throw new Error('任务队列未启用，群日报无法注册');
    if (!ctx.dailyReport) throw new Error('dailyReport 服务未注入');
    ctx.jobs.register('dailyReport', (job) => ctx.dailyReport.run(job));
    const queued = ctx.dailyReport.sync();
    if (queued) ctx.log(`已登记 ${queued} 个群的日报任务`);
  }
};
