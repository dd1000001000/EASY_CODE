# 贪吃蛇（Python）

一个纯 Python 标准库实现的贪吃蛇游戏：

- W / A / S / D（或方向键）控制移动
- 4 张预置地图：经典空场 / 四边框 / 十字迷宫 / 简易迷宫
- 4 档难度（速度）：简单 / 普通 / 困难 / 地狱
- 图形界面（Tkinter）优先，无图形界面时自动回退到终端版

## 运行

```bash
cd "snake game"
python snake_game.py
```

## 操作说明

| 按键 | 功能 |
| ---- | ---- |
| W / ↑ | 向上 |
| A / ← | 向左 |
| S / ↓ | 向下 |
| D / → | 向右 |
| P / 空格 | 暂停 / 继续 |
| R | 重新开始本局 |
| Q / Esc | 退出游戏 |

## 地图与难度

启动后按提示输入编号选择地图和速度（1~4）。

- 地图 1 经典空场：没有墙，穿过边界会从对面出现（环绕模式）
- 地图 2 四边框：四周有墙，撞墙即死
- 地图 3 十字迷宫：一横一竖两道墙，中央出生区
- 地图 4 简易迷宫：多段短墙与缺口

速度档位（每格耗时）：简单 200ms、普通 130ms、困难 85ms、地狱 50ms。

## 项目结构

```
snake game/
├── snake_game.py   # 入口：菜单 + 选择地图/难度
├── engine.py       # 核心逻辑（与界面无关，可测试）
├── maps.py         # 预置地图与速度配置
├── gui.py          # Tkinter 图形界面
├── terminal.py     # 终端界面（msvcrt / termios）
├── README.md
└── tests/
    └── test_engine.py  # 单元测试
```

## 运行测试

```bash
python -m unittest discover -s tests -v
```

## 依赖

仅使用 Python 标准库（tkinter / msvcrt / termios 等），无需 pip 安装任何第三方包。
