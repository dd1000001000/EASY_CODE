"""终端版贪吃蛇渲染与输入。

Windows 使用 msvcrt 读取按键，Unix 使用 termios + select。
若标准输入不是交互终端，则退化为逐行输入模式。
"""

import os
import sys
import time

try:
    import msvcrt
    _WINDOWS = True
except ImportError:
    _WINDOWS = False
    import select
    import termios
    import tty

_WIN_KEY_DIR = {
    b"w": (0, -1), b"a": (-1, 0), b"s": (0, 1), b"d": (1, 0),
    b"W": (0, -1), b"A": (-1, 0), b"S": (0, 1), b"D": (1, 0),
}
_WIN_ARROWS = {b"H": (0, -1), b"P": (0, 1), b"M": (-1, 0), b"K": (1, 0)}
_UNIX_DIR = {"w": (0, -1), "a": (-1, 0), "s": (0, 1), "d": (1, 0),
             "W": (0, -1), "A": (-1, 0), "S": (0, 1), "D": (1, 0)}
_UNIX_ARROWS = {"A": (0, -1), "B": (0, 1), "D": (-1, 0), "C": (1, 0)}
_LINE_DIR = {"w": (0, -1), "a": (-1, 0), "s": (0, 1), "d": (1, 0)}


def _poll_keys():
    """读取当前已按下的按键，返回方向元组或命令字符串的列表。"""
    keys = []
    if _WINDOWS:
        while msvcrt.kbhit():
            ch = msvcrt.getch()
            if ch in (b"\x00", b"\xe0"):
                ch2 = msvcrt.getch()
                d = _WIN_ARROWS.get(ch2)
                if d:
                    keys.append(d)
            elif ch in _WIN_KEY_DIR:
                keys.append(_WIN_KEY_DIR[ch])
            elif ch in (b"p", b"P", b" "):
                keys.append("pause")
            elif ch in (b"r", b"R"):
                keys.append("restart")
            elif ch in (b"q", b"Q", b"\x1b"):
                keys.append("quit")
        return keys

    while True:
        ready, _, _ = select.select([sys.stdin], [], [], 0)
        if not ready:
            break
        ch = os.read(sys.stdin.fileno(), 1).decode("latin-1")
        if ch == "\x1b":
            ready, _, _ = select.select([sys.stdin], [], [], 0)
            if not ready:
                keys.append("quit")   # 单独按下 Esc
                continue
            if os.read(sys.stdin.fileno(), 1).decode("latin-1") == "[":
                ready, _, _ = select.select([sys.stdin], [], [], 0)
                if ready:
                    seq = os.read(sys.stdin.fileno(), 1).decode("latin-1")
                    d = _UNIX_ARROWS.get(seq)
                    if d:
                        keys.append(d)
        elif ch in _UNIX_DIR:
            keys.append(_UNIX_DIR[ch])
        elif ch in "pP ":
            keys.append("pause")
        elif ch in "rR":
            keys.append("restart")
        elif ch in "qQ":
            keys.append("quit")
    return keys


class TerminalSnake:
    """在终端中运行一局贪吃蛇。"""

    def __init__(self, game, interval_ms, make_game):
        self.game = game
        self.interval = interval_ms / 1000.0
        self.make_game = make_game
        self.paused = False

    def run(self):
        if _WINDOWS:
            os.system("")  # 启用 Windows 10+ 终端的 ANSI 转义
        if not sys.stdin.isatty():
            self._run_line_mode()
            return
        print("\x1b[2J\x1b[H", end="")
        print("W/A/S/D 移动    P 暂停    R 重玩    Q 返回菜单")
        print()
        old = None
        try:
            if not _WINDOWS:
                old = termios.tcgetattr(sys.stdin)
                tty.setcbreak(sys.stdin.fileno())
            while True:
                for key in _poll_keys():
                    if key == "pause" and not self.game.over:
                        self.paused = not self.paused
                    elif key == "restart":
                        self.game = self.make_game()
                        self.paused = False
                    elif key == "quit":
                        return
                    elif isinstance(key, tuple):
                        self.game.queue_direction(key)
                if not self.paused and not self.game.over:
                    self.game.step()
                self._draw()
                if self.game.over:
                    time.sleep(0.15)  # 结束画面下稍作停留，避免空转
                time.sleep(self.interval if not self.paused else 0.05)
        finally:
            if old is not None:
                termios.tcsetattr(sys.stdin, termios.TCSADRAIN, old)
            print("\x1b[2J\x1b[H", end="")

    def _run_line_mode(self):
        """非交互终端：每行输入一个方向键。"""
        print("检测到非交互终端，使用逐行输入模式。")
        print("w/a/s/d 移动，p 暂停，r 重玩，q 退出，回车确认。")
        while True:
            try:
                line = input("> ").strip().lower()
            except (EOFError, KeyboardInterrupt):
                break
            if not line:
                continue
            first = line[0]
            if first in _LINE_DIR:
                self.game.queue_direction(_LINE_DIR[first])
            elif first == "p" and not self.game.over:
                self.paused = not self.paused
            elif first == "r":
                self.game = self.make_game()
                self.paused = False
            elif first == "q":
                break
            else:
                print("未知按键，请使用 w/a/s/d/p/r/q")
            if not self.paused and not self.game.over:
                self.game.step()
            self._draw()
            if self.game.over:
                print(f"游戏结束！最终得分：{self.game.score}")

    # ---- 绘制 ----
    def _draw(self):
        g = self.game
        status = f"得分：{g.score}"
        if self.paused:
            status += "   [已暂停，按 P 继续]"
        if g.over:
            status += "   " + ("恭喜通关！" if g.won else "游戏结束！按 R 重玩 / Q 返回菜单")
        lines = [status]
        top = "+" + "-" * g.cols + "+"
        lines.append(top)
        for y in range(g.rows):
            cells = []
            for x in range(g.cols):
                if g.grid[y][x] == "#":
                    cells.append("#")
                elif g.food is not None and (x, y) == g.food:
                    cells.append("*")
                elif (x, y) == g.snake[0]:
                    cells.append("O")
                elif (x, y) in g.snake[1:]:
                    cells.append("o")
                else:
                    cells.append(" ")
            lines.append("|" + "".join(cells) + "|")
        lines.append(top)
        print("\x1b[2J\x1b[H" + "\n".join(lines), end="")
        sys.stdout.flush()
