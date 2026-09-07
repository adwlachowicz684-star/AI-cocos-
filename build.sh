#!/bin/bash
# 构建脚本
#
# ============================================================
# 【⚠️ 为什么用 cd "$(dirname "$0")" 而不是写死路径】
# ============================================================
# 第一版写的是 `cd /data/workspace/cocos-kit`。
#
# 后果：把压缩包解压到任何别的路径（D 盘、~/Downloads、另一台机器），
# 脚本都会 cd 回那个根本不存在的原路径去编译。
# 产物落在原处，当前目录的 .build 始终是空的，
# 然后报 `Cannot find module './.build/tests/run.js'`。
#
# 错误信息完全不提路径——看起来像"测试文件丢了"，
# 实际是"编译根本没在这里发生"。
#
# 脚本必须相对自身定位。硬编码路径的脚本不可分发。

cd "$(dirname "$0")" || exit 1

# ---- 依赖检查 ----
# 没有 node_modules 时直接调 tsc 会报
#   ./node_modules/typescript/bin/tsc: No such file or directory
# 这句话没说"要先装依赖"，容易让人以为是包坏了。
if [ ! -x "./node_modules/typescript/bin/tsc" ]; then
  echo "✗ 找不到 TypeScript，请先安装依赖："
  echo ""
  echo "    npm install"
  echo ""
  echo "  （只需要 typescript 一个开发依赖，装完约 60MB，"
  echo "    用完可以整个删掉 node_modules/。运行时不需要它。）"
  exit 1
fi

# ============================================================
# 【为什么构建到临时目录，而不是 rm -rf .build 再编译】
# ============================================================
# 曾经观察到"编译成功但产物逐渐消失"：
#
#     TSC OK
#     立刻:  189 个 .js
#     3秒后:  42 个
#     8秒后:   0 个        ← 全部没了
#
# 我当时的判断是"这个文件系统的 rm 是异步的"，**这个结论是错的**。
#
# 真实原因：一次被中断的会话残留了一个后台进程，它在不停跑
# `rm -rf .build`。杀掉它之后，189 → 189 → 189，12 秒纹丝不动。
#
# 【但为什么保留这个写法】
# 教训不在"文件系统会异步删"，而在：
#   **`rm -rf X` 之后再往 X 里写，X 的内容取决于有没有别的东西也在动 X。**
# 构建脚本不该把正确性建立在"没人跟我抢"这个假设上。
#
# 所以改成：永远不 rm 一个正要写入的目录。
# 每次构建到 PID+时间戳命名的唯一临时目录（没有任何旧的删除会指向它），
# 再用原子重命名换上来。旧产物改名后丢到后台慢慢删——
# 删不删得干净都不影响本次构建。
#
# 【附】如果你遇到同样的"产物消失"：
#     ps aux | grep 'rm -rf'
#     pkill -f 'rm -rf .build'
# 先确认不是自己上一轮的残留进程，再怀疑文件系统。

STAMP="$$-$(date +%s%N)"
TMP=".build.new.$STAMP"
OLD=".build.old.$STAMP"

# ---- 清理上一次被强杀留下的残留 ----
#
# 【为什么会残留】build 被 SIGKILL（超时、连按两次 Ctrl-C）时，
# 下面的 trap cleanup 不会执行，`.build.new.*` / `.build.old.*` 就留下了。
#
# 【不清理会怎样】它们会让 `npm run check:deps` 之类的扫描脚本
# 把构建产物当成插件目录扫进去，报出指向库内部的 ENOENT。
#
# 这里只删**别人的**残留（时间戳不等于本次的），不碰本次正在用的。
for left in .build.new.* .build.old.*; do
  [ -e "$left" ] || continue
  case "$left" in
    *"$STAMP"*) continue ;;
  esac
  rm -rf "$left" 2>/dev/null
done

cleanup() { rm -rf "$TMP" "$OLD" 2>/dev/null; }
trap cleanup EXIT

# 源码里有多少个 .ts，产物里就该有多少个 .js
src_count=$(find . -name '*.ts' -not -path './node_modules/*' \
              -not -path './.build*' -not -name '*.d.ts' | wc -l)

ok=0
for attempt in 1 2 3; do
  rm -rf "$TMP" 2>/dev/null

  ./node_modules/typescript/bin/tsc -p tsconfig.json --outDir "$TMP" > /tmp/tsc.out 2>&1
  if [ -s /tmp/tsc.out ]; then
    echo "TSC 失败:"
    head -25 /tmp/tsc.out
    exit 1
  fi

  js_count=$(find "$TMP" -name '*.js' 2>/dev/null | wc -l)

  # 允许少量偏差（纯类型文件不产出 .js）
  total_ok=1
  [ -f "$TMP/tests/run.js" ] || total_ok=0
  [ "$js_count" -ge $((src_count - 20)) ] || total_ok=0

  # ============================================================
  # 【⚠️ 为什么还要逐文件比对 tests/，光看总数不够】
  # ============================================================
  # 曾经出现过：总数校验通过（209 个 .js），但 `.build/tests/`
  # 只剩 18 个文件（应有 41 个）——`_framework.js`、`run_phase7.js`、
  # `run_phase2/5.js` 等全部丢失。
  #
  # 后果不是"编译失败"，而是**运行 `node .build/tests/run.js` 直接
  # MODULE_NOT_FOUND**。更糟的是如果丢的只是某个 run_phaseN.js，
  # 而 run.ts 里的 import 又被 bundler 容错掉，
  # 那批测试就会**静默不执行**——回归数字看着正常，实际少跑了一整批。
  #
  # 总数校验抓不到这个：tests 少 23 个，别的目录多几个就补平了。
  # 所以必须逐个文件确认"每个 tests/*.ts 都有对应的 .js"。
  missing=""
  for ts in tests/*.ts; do
    [ -e "$ts" ] || continue
    base=$(basename "$ts" .ts)
    # 纯类型文件（只有 interface/type）不产出 .js，跳过
    if ! grep -qE '^(export )?(declare )?(function|class|const|let|var|enum|namespace)' "$ts" \
       && ! grep -qE '^(export )?(declare )?(function|class|const|let|var|enum|namespace)' "$ts"; then
      continue
    fi
    [ -f "$TMP/tests/$base.js" ] || missing="$missing $base"
  done

  if [ -n "$missing" ]; then
    echo "  （第 $attempt 次编译产物缺 tests 文件：$missing，重试）"
    total_ok=0
  fi

  if [ "$total_ok" -eq 1 ]; then
    ok=1
    break
  fi
  echo "  （第 $attempt 次编译产物不完整：$js_count/$src_count，重试）"
done

if [ "$ok" -ne 1 ]; then
  echo "✗ 连续 3 次编译产物都不完整（源码 $src_count 个 .ts）"
  echo "  完整错误见 /tmp/tsc.out"
  exit 1
fi

# 两次原子换名：旧产物改名 → 新产物上位。
# 之后后台慢慢删旧的，删不干净也不影响。
[ -d .build ] && mv .build "$OLD" 2>/dev/null
mv "$TMP" .build || { echo "✗ 无法替换 .build"; exit 1; }
( rm -rf "$OLD" 2>/dev/null ) &

# ============================================================
# 【⚠️ 为什么 mv 之后还要检查"是不是被套了一层"】
# ============================================================
# 观察到：`rm -rf .build` / `mv .build "$OLD"` 返回 0，
# 但紧接着 `[ -d .build ]` 仍为真（目录项缓存有延迟）。
# 于是 `mv "$TMP" .build` 不是"改名成 .build"，
# 而是**把临时目录搬进了已存在的 .build 里**：
#
#     .build/.build.new.<PID-时间戳>/tests/run.js
#
# 结果 `node .build/tests/run.js` 直接 MODULE_NOT_FOUND，
# 症状很像"编译产物又消失了"——其实它好端端在，只是多套了一层目录。
#
# 【为什么不做"mv 之前先确认 .build 不存在"】
# 试过，在这个文件系统上 `rm -rf` 返回后 `[ -d .build ]` 仍可能为真，
# 于是脚本会误判成"清不掉"而退出。**事前校验在这个文件系统上不可靠**，
# 只能事后检查真实布局并自愈。
if [ ! -f .build/tests/run.js ]; then
  nested=$(ls -d .build/.build.new.* 2>/dev/null | head -1)
  if [ -n "$nested" ] && [ -f "$nested/tests/run.js" ]; then
    echo "  （检测到产物被套了一层目录，正在摊平）"
    # 把嵌套内容提到 .build 下：先整体挪到同级临时名，再替换
    mv "$nested" "$TMP.flat" 2>/dev/null
    rm -rf .build 2>/dev/null
    mv "$TMP.flat" .build 2>/dev/null
  fi
fi

if [ ! -f .build/tests/run.js ]; then
  echo "✗ 产物位置异常：.build/tests/run.js 不存在"
  echo "  .build 下的内容："
  ls .build 2>/dev/null | head -5
  exit 1
fi

echo "TSC OK（产物校验通过：$js_count 个 .js）"
