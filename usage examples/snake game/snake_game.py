"""贪吃蛇游戏 —— 程序入口。

用法：
    python snake_game.py

启动后先在地图与难度菜单中做出选择，再开始游戏。
"""

from engine import Game
from maps import MAPS, SPEEDS


def _ask_index(count, prompt):
    while True:
        try:
            raw = input(prompt).strip()
        except (EOFError, KeyboardInterrupt):
            return None
        if raw.isdigit() and 1 <= int(raw) <= count:
            return int(raw) - 1
        print(f"输入无效，请输入 1~{count} 之间的数字。")


def select_map():
    print("\n========== 选择地图 ==========")
    for i, m in enumerate(MAPS, 1):
        print(f"  [{i}] {m['name']}（{m['desc']}）")
    return _ask_index(len(MAPS), "请输入地图编号：")


def select_speed():
    print("\n========== 选择难度（速度） ==========")
    for i, s in enumerate(SPEEDS, 1):
        print(f"  [{i}] {s['name']}（每格 {s['interval_ms']} 毫秒）")
    return _ask_index(len(SPEEDS), "请输入难度编号：")


def play(map_index, speed_index):
    m = MAPS[map_index]
    s = SPEEDS[speed_index]
    interval_ms = s["interval_ms"]

    def make_game():
        return Game(m["builder"](), wrap=m["wrap"])

    try:
        import tkinter as tk
        root = tk.Tk()
    except Exception:
        # 没有可用图形界面时，回退到终端版
        from terminal import TerminalSnake
        TerminalSnake(make_game(), interval_ms, make_game).run()
        return

    from gui import SnakeApp
    root.title(f"贪吃蛇 - {m['name']} - {s['name']}")
    root.resizable(False, False)
    SnakeApp(root, make_game(), interval_ms, make_game, s["name"], m["name"])
    root.mainloop()


def main():
    print("欢迎来到贪吃蛇！")
    while True:
        map_index = select_map()
        if map_index is None:
            return
        speed_index = select_speed()
        if speed_index is None:
            return
        play(map_index, speed_index)
        try:
            again = input("\n再来一局？(y/n)：").strip().lower()
        except (EOFError, KeyboardInterrupt):
            break
        if again not in ("y", "yes"):
            break
    print("再见！")


if __name__ == "__main__":
    main()
