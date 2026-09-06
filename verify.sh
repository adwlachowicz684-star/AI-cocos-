#!/bin/bash
# 全量验证：编译 → 测试 → 依赖图 → 示例 → 文档完整性
#
# 【路径】用 cd "$(dirname "$0")"，不硬编码。理由见 build.sh 的注释。

cd "$(dirname "$0")" || exit 1

# ---- 依赖检查 ----
#
# 【为什么要在这里再查一次】
# build.sh 里已经有同样的检查，但 verify.sh **直接调了 tsc**，
# 没装依赖时它报的是：
#
#     ./verify.sh: line 10: ./node_modules/typescript/bin/tsc: No such file or directory
#
# 这句话完全不提"先装依赖"。解压到新路径的用户第一次一定撞上。
#
# build.sh 顶着这个坑修过一次，verify.sh 是第二个入口，
# **同一个坑在每个入口都要各自堵**。
if [ ! -x "./node_modules/typescript/bin/tsc" ]; then
  echo "✗ 找不到 TypeScript，请先安装依赖："
  echo ""
  echo "    npm install"
  echo ""
  exit 1
fi

fail=0

echo "======== 1. 编译 ========"
./build.sh
if [ $? -ne 0 ]; then echo "编译失败"; exit 1; fi

echo ""
echo "======== 2. 测试 ========"
node .build/tests/run.js 2>&1 | tail -3
if [ ${PIPESTATUS[0]} -ne 0 ]; then fail=1; fi

echo ""
echo "======== 3. 依赖图 ========"
node scripts/check-deps.js 2>&1 | tail -4
if [ ${PIPESTATUS[0]} -ne 0 ]; then fail=1; fi

echo ""
echo "======== 4. 文档完整性 ========"
node scripts/gen-inventory.js --check 2>&1 | tail -2
if [ ${PIPESTATUS[0]} -ne 0 ]; then fail=1; fi

echo ""
echo "======== 5. 文档断链 ========"
node scripts/check-links.js 2>&1 | tail -3
if [ ${PIPESTATUS[0]} -ne 0 ]; then fail=1; fi

echo ""
echo "======== 6. 同名导出冲突 ========"
python3 scripts/check-dup-exports.py 2>&1 | tail -1
if [ ${PIPESTATUS[0]} -ne 0 ]; then fail=1; fi

echo ""
echo "======== 7. 文档反查（编造的 API） ========"
python3 scripts/check-doc-refs.py 2>&1 | tail -1
if [ ${PIPESTATUS[0]} -ne 0 ]; then fail=1; fi

echo ""
echo "======== 8. 随机源复用（禁止自建 DefaultRandom） ========"
python3 scripts/check-random-source.py 2>&1 | tail -1
if [ ${PIPESTATUS[0]} -ne 0 ]; then fail=1; fi

echo ""
echo "======== 9. 实测数字必须标样本量 ========"
#
# 【为什么要这一项】
# noise 的极值曾经写成 [-1.279, 1.208]（小样本，极值偏低 8%），
# 没标样本量 → 被当成精确值用 → 谁按它做归一化仍有 0.157% 溢出。
# steering 的"1.77"（实测 17.64，差 10 倍）同理。
python3 scripts/check-measured-numbers.py 2>&1 | tail -4
if [ ${PIPESTATUS[0]} -ne 0 ]; then fail=1; fi

echo ""
echo "======== 10. 示例 ========"
#
# 【为什么改成遍历目录，不再硬编码列表】
#
# 原来的写法是把 20 个示例名字写死在 for 循环里。
# 结果 demo-moveloop.js 一直没被跑过——它的文件名不符合
# `${name}-usage.js` 的模板（对应的是 `example:demo`），
# 所以即便它编译出来了，也永远不会出现在这个列表里。
#
# 这就是"上次报 20 个示例、实际只跑了 19 个"的根因。
# **硬编码的清单一定会过期**，而过期的时候它不会报错，
# 只是悄悄少跑一个——这比报错更糟。
#
# 改成遍历 .build/examples/*.js：新增示例自动纳入，不需要记得改这里。
for f in .build/examples/*.js; do
  name=$(basename "$f")
  out=$(node "$f" 2>&1); code=$?
  if [ $code -ne 0 ]; then
    echo "  ✗ $name (exit=$code)"
    echo "$out" | tail -3
    fail=1
  else
    echo "  ✓ $name"
  fi
done

#
# 【为什么第 11 步放在最后】
# 这条规则是"dt 参与算术前必须过 safeDt"，它管的是**新写的代码**
# 会不会再次引入同类缺陷，与前面 10 步验证的存量无关。
# 放最后是因为它扫全库 145 个文件，是单步里最慢的之一，
# 失败时前面更快的信息已经打出来了，不用等它。
#
# 【误报率说明】
# 接入前做过注入验证：把 score 的 `safeDt(dt)` 改回 `dt > 0` 能精准报出 1 处，
# 还原后归零。已知盲区（正则匹配不到对象联合返回类型）记在脚本文件头。
echo ""
echo "======== 11. dt 守卫（异常数值穿透） ========"
python3 scripts/scan-dt-guard.py 2>&1 | tail -3
if [ ${PIPESTATUS[0]} -ne 0 ]; then fail=1; fi

# 【为什么单独一步，不并进第 11 步】
# 两者防的是同一族问题（异常数值穿透），但规则完全不同：
#   11 步管 dt：方法体内的 `+= dt` 有没有守卫
#   12 步管配置：`Math.max(1, opts.x ?? N)` 有没有用 numOr/clampNum
# 合并成一个脚本会让"哪条规则拦下了什么"变模糊，而失败信息的可读性
# 正是这类检查唯一的价值——报错看不懂，人就会绕过它。
#
# 【接入前的验证】
# 存量 0；注入探针验证过四种反向用例（numOr 已包裹 / 非外部来源 /
# 行注释 / 块注释）都正确放过，只命中真正未收口的那 1 处。
echo ""
echo "======== 12. 配置项非有限值（Math.max/min 兜底） ========"
python3 scripts/scan-num-guard.py 2>&1 | tail -3
if [ ${PIPESTATUS[0]} -ne 0 ]; then fail=1; fi

echo ""
if [ $fail -eq 0 ]; then echo "全部通过 ✓"; else echo "有失败 ✗"; fi
exit $fail
