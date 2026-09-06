/**
 * IDamageable —— 伤害契约
 *
 * 【这是整个战斗系统可复用的关键】
 *
 * 如果伤害函数签名是 `takeDamage(e: Enemy)`，它就永远只能打敌人——
 * 玩家的箱子、可破坏的墙、Boss 的护盾、草丛全部打不了。
 *
 * 改成 `IDamageable` 后，**任何"能被扣血的东西"都能接入**：
 * 角色、敌人、Boss、木箱、墙壁、载具、甚至一个抽象的"队伍"。
 *
 * 【它不认识 Player / Enemy / Boss】——这就是零业务依赖。
 */

/**
 * 伤害上下文：一次伤害结算需要的所有信息
 *
 * 【为什么把所有信息打包成一个对象】
 * 函数参数会随着需求增加不断膨胀（加个元素类型、加个是否背刺……）。
 * 用对象，加字段不影响已有调用点。
 */
export interface DamageContext {
  /** 原始伤害值（未经过任何修正） */
  readonly raw: number;

  /** 伤害类型：'physical' / 'fire' / 'ice' / 'true' …… 开放字符串，由调用方定义 */
  readonly type?: string;

  /** 攻击方（可以是任何东西，管线不解释它） */
  readonly source?: unknown;

  /** 是否暴击（由暴击判定阶段填写） */
  crit?: boolean;
  /** 暴击倍率 */
  critMul?: number;

  /** 护甲穿透（0..1，1 = 完全无视护甲） */
  armorPen?: number;
  /** 抗性穿透 */
  resistPen?: number;

  /** 命中部位（用于分部位倍率，如爆头） */
  part?: string;

  /**
   * 唯一判定 id，用于去重
   *
   * 【关键】多段伤害、AOE、持续伤害最容易出的 bug 就是
   * "同一帧对同一目标结算了 N 次"，表现为一刀秒杀 Boss。
   */
  hitId?: string;

  /** 扩展字段：调用方可以塞任何东西，管线原样透传 */
  readonly meta?: Record<string, unknown>;
}

/** 伤害结算结果 */
export interface DamageResult {
  /** 最终伤害（已取整、已保底） */
  readonly value: number;
  readonly isCrit: boolean;
  readonly type: string;

  /**
   * 每个阶段的中间值
   *
   * 【为什么需要】
   * ① 调试：伤害不对时，能立刻看出是哪个阶段算错了
   * ② 展示：UI 可以显示"基础 20 → 暴击 40 → 护甲后 28"
   */
  readonly stages: ReadonlyArray<{ name: string; value: number }>;

  /** 被完全免疫（伤害为 0 且不是因为取整） */
  readonly immune: boolean;
}

/** 最小契约：只要求"能扣血、能查询状态" */
export interface IDamageable {
  /** 当前生命值 */
  readonly hp: number;
  /** 生命上限（用于 UI 百分比） */
  readonly maxHp: number;
  /** 护甲值（管线会用除法公式处理） */
  readonly armor?: number;
  /** 抗性表：伤害类型 → 减伤系数（-1 到 1，负数表示易伤） */
  readonly resistances?: Readonly<Record<string, number>>;

  /**
   * 应用伤害
   *
   * 【注意】这个方法**应该只负责扣血**，不要在这里播特效、飘字、音效。
   * 计算和表现分离，才能做批量模拟（关掉表现层跑几千场战斗验证平衡）。
   */
  applyDamage(result: DamageResult, ctx: DamageContext): void;

  isAlive(): boolean;
}
