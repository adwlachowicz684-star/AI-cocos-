/**
 * typings/cc.d.ts —— Cocos 'cc' 模块的最小类型桩
 *
 * 【这个文件是干什么的】
 * 插件库的**纯逻辑层**（EventBus / Pool / RNG / DamagePipeline / Track /
 * SkillPlayer / JoystickCore）不依赖引擎，可以直接用 tsc 编译和单测。
 *
 * 但 `joystick-mover/JoystickMover.ts` 是 Cocos 组件，import 了 'cc'。
 * 在没有引擎环境的机器上（CI、Node 单测）编译会报「找不到模块 cc」。
 *
 * 解决办法：提供一个最小类型桩，让类型检查能通过。
 *
 * 【重要】
 * - 在**真实的 Cocos 项目**里，请删除本目录，使用引擎自带的 cc 类型
 * - 本桩只覆盖 JoystickMover 用到的 API，不是完整的引擎声明
 * - 它只用于类型检查，**不能用于运行**
 */
declare module 'cc' {
  export const _decorator: {
    ccclass: (name: string) => <T extends new (...args: any[]) => any>(ctor: T) => T;
    property: (opts?: any) => (target: any, key: string) => void;
  };

  export class Node {
    static EventType: {
      TOUCH_START: string;
      TOUCH_MOVE: string;
      TOUCH_END: string;
      TOUCH_CANCEL: string;
    };
    active: boolean;
    position: Vec3;
    on(type: string, cb: (e: any) => void, target?: any): void;
    off(type: string, cb: (e: any) => void, target?: any): void;
    setPosition(x: number, y: number, z?: number): void;
    getComponent<T>(ctor: new (...args: any[]) => T): T | null;
  }

  export class Component {
    node: Node;
    onLoad?(): void;
    onDestroy?(): void;
  }

  export class UITransform {
    convertToNodeSpaceAR(worldPos: Vec3, out?: Vec3): Vec3;
  }

  export class Vec2 {
    x: number;
    y: number;
    constructor(x?: number, y?: number);
    set(x: number, y: number): void;
  }

  export class Vec3 {
    x: number;
    y: number;
    z: number;
    constructor(x?: number, y?: number, z?: number);
    set(x: number, y: number, z: number): void;
  }

  export class EventTouch {
    getID(): number;
    getUILocation(): { x: number; y: number };
  }
}
