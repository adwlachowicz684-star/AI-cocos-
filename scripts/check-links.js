/**
 * scripts/check-links.js —— 检查 Markdown 内部链接是否断链
 *
 * 【为什么要有这个脚本】
 *
 * 库里有 7 份顶层文档 + 121 份插件 README，它们之间互相引用。
 * 之前每次都是我临时在命令行里敲一段 node -e 来检查——
 * **临时代码检查过的东西，下次换个人（或换一轮对话）就不会再查了**。
 *
 * 断链这事的坑在于：它不会让编译失败，也不会让测试挂，
 * 只是用户点进去看到 404。而文档的目的就是让人能顺着链接走下去。
 *
 * 【检查范围】
 *   - 形如 `](./xxx.md)` 或 `](../foo/README.md)` 的相对链接
 *   - 带锚点的链接 `](./foo.md#section)` 只检查文件存在，不校验锚点
 *     （锚点校验需要解析标题生成规则，容易误报，收益不大）
 *
 * 【不检查】
 *   - http(s) 外链（可能只是网络不通，不是文档问题）
 *   - 纯锚点 `#xxx`（同文件内跳转）
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * 剔除代码区，返回只含"散文"的文本（长度与原文本一致，便于定位）
 *
 * 【为什么要剔除】
 * markdown 规范里，**行内代码（`...`）与围栏代码块（```...```）中的内容是字面文本**，
 * 里面的 `](./x.md)` 不是链接，只是"在讲解/引用链接语法"。
 *
 * 不剔除会怎样：本库 16 个窗口在报告里互相引用对方的修复代码，
 * 凡是出现 ```](...)` `` 或 `return this._derived[id](...)` 这类片段的行，
 * 都会被当成真链接去解析，于是报出"断链"——
 * 实测一次抽查就误报 8 处，分布在 4 个窗口的文件里，
 * 且每多写一份报告就多几处。各窗口为了让它变绿而去改自己报告的写法，
 * 既治标不治本，还会把示例代码改得读不懂。
 *
 * 【为什么替换成空格而不是直接删】
 * 保持字符数不变，正则匹配到的索引仍对应原文件位置（便于将来报错定位），
 * 也不会让两段被代码隔开的文本意外拼成一个假链接。
 */
function stripCode(md) {
  const lines = md.split('\n');
  const out = [];

  let inFence = false;
  let fenceChar = '';

  for (const line of lines) {
    // 围栏代码块：``` 或 ~~~（可带语言标注），用空行占位
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      const ch = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
      } else if (ch === fenceChar) {
        inFence = false;
      }
      out.push('');
      continue;
    }
    if (inFence) {
      out.push('');
      continue;
    }

    // 行内代码：`...` / ``...``（同一行内非贪婪，长度不变地替换为空格）
    out.push(line.replace(/(`+)(?:[\s\S]*?)\1/g, (s) => ' '.repeat(s.length)));
  }

  return out.join('\n');
}

/** 递归收集所有 .md 文件（跳过 node_modules 与 .build） */
function collectMd(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.build') || name === '.git') continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) collectMd(p, out);
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

function main() {
  const files = collectMd(ROOT);
  let total = 0;
  const broken = [];

  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    // 只在"散文"里找链接：代码区里的 ](...) 是字面文本，不是链接
    const content = stripCode(raw);
    const dir = path.dirname(file);

    // 匹配 ]( 开头、非 http、非纯锚点、非 mailto 的链接
    const re = /\]\((\.[^)\s]+)\)/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const raw = m[1];
      // 去掉锚点部分，只保留路径
      const target = raw.split('#')[0];
      if (!target) continue;
      total++;

      const resolved = path.resolve(dir, target);
      if (!fs.existsSync(resolved)) {
        broken.push({
          file: path.relative(ROOT, file),
          link: raw,
          resolved: path.relative(ROOT, resolved),
        });
      }
    }
  }

  if (broken.length === 0) {
    console.log(`[OK] 内部链接 ${total} 条，断链 0 处（扫描 ${files.length} 个 .md 文件）`);
    return 0;
  }

  console.log(`[✗] 内部链接 ${total} 条，断链 ${broken.length} 处：\n`);
  for (const b of broken) {
    console.log(`  ${b.file}`);
    console.log(`      → ](${b.link})  解析为 ${b.resolved}\n`);
  }
  return 1;
}

process.exit(main());
