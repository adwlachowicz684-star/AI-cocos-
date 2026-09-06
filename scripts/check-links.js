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
    const content = fs.readFileSync(file, 'utf8');
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
