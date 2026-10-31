// 人格卡（personas/<名称>.md）的解析与「按仿真模式取用」。
//
// 为什么要分模式：
//   旧版仿真（reserved）用空格分条、用 [SILENT] 表示沉默；
//   群聊仿真（simulation）必须用工具发言（qq_send_message 的数组分条），没有 [SILENT]。
//   同一张人格卡被两种模式共用时，旧版专属指令会与仿真工具协议冲突。
// 以前靠逐行正则猜测，既容易误伤又说不清边界。
//
// 现在改为显式标记：在标题里写模式，桥接只取当前模式适用的小节。
//   ## 表情包体系 〔仿真〕      → 只在 simulation 注入
//   ## 分条方式 〔旧版〕        → 只在 reserved/chat 注入
//   ## 你是谁                   → 两种模式都注入
// 标记会在注入前从标题里去掉，模型看到的始终是干净的小节标题。
export const ROLE_INJECT_MODES = ['legacy', 'simulation'];

// 模式标记：`〔仿真〕` / `[simulation]` / `（群聊仿真）` / `（群聊剧场）`；旧版用 `〔旧版〕` / `[legacy]`。
const MODE_TAGS = [
  { mode: 'simulation', re: /[\[〔（(]\s*(?:群聊剧场|群聊仿真|仿真|simulation)\s*[\]〕）)]/gi },
  { mode: 'legacy', re: /[\[〔（(]\s*(?:旧版仿真|旧版|legacy|reserved)\s*[\]〕）)]/gi },
];

function detectMode(heading) {
  for (const tag of MODE_TAGS) {
    tag.re.lastIndex = 0;
    if (tag.re.test(heading)) return tag.mode;
  }
  return 'all';
}

function stripModeTags(heading) {
  let out = String(heading);
  for (const tag of MODE_TAGS) {
    tag.re.lastIndex = 0;
    out = out.replace(tag.re, '');
  }
  return out.replace(/[ \t]+$/, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * 按标题把人格卡拆成小节。
 * @returns {{mode: 'all'|'legacy'|'simulation', heading: string|null, lines: string[]}[]}
 */
export function parseRoleSections(text) {
  const sections = [];
  let current = null;
  for (const line of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!heading) {
      if (!current) {
        current = { mode: 'all', heading: null, lines: [] };
        sections.push(current);
      }
      current.lines.push(line);
      continue;
    }
    const title = stripModeTags(heading[2]);
    current = { mode: detectMode(heading[2]), heading: title, lines: [`${heading[1]} ${title}`] };
    sections.push(current);
  }
  return sections;
}

/**
 * 取出某次仿真真正要注入的人格文本（已去掉模式标记）。
 * @param {'legacy'|'simulation'} mode
 */
export function selectRoleText(text, mode) {
  const want = mode === 'legacy' ? 'legacy' : 'simulation';
  return parseRoleSections(text)
    .filter((section) => section.mode === 'all' || section.mode === want)
    .map((section) => section.lines.join('\n'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 报告每个小节在当前模式下是否会被注入，供控制台预览。
 * @param {'legacy'|'simulation'} mode
 */
export function roleSectionReport(text, mode) {
  const want = mode === 'legacy' ? 'legacy' : 'simulation';
  return parseRoleSections(text).map((section) => ({
    heading: section.heading ?? '(开头部分)',
    mode: section.mode,
    injected: section.mode === 'all' || section.mode === want,
    chars: section.lines.join('\n').trim().length,
  }));
}

/** 统计各模式的字符数，用于控制台提示「去掉另一模式的专属小节后还剩多少」。 */
export function roleCharStats(text) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n');
  const sections = parseRoleSections(source);
  const sum = (list) => list.reduce((total, section) => total + section.lines.join('\n').trim().length, 0);
  return {
    total: source.length,
    common: sum(sections.filter((section) => section.mode === 'all')),
    legacyOnly: sum(sections.filter((section) => section.mode === 'legacy')),
    simulationOnly: sum(sections.filter((section) => section.mode === 'simulation')),
    legacy: selectRoleText(source, 'legacy').length,
    simulation: selectRoleText(source, 'simulation').length,
  };
}

// 旧版仿真遗留指令：未加模式标记时，这些行在仿真下会被兜底过滤。
// 正确做法是给所在小节加上 〔旧版〕 标记。
export const LEGACY_ROLE_LINE_RE = /\[SILENT\]|空格分隔|按空格|用空格|空格分句|空格代表|自动转发|回复会自动|输出\s*\[SILENT\]/i;
