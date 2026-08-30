"""Tkinter 图形界面（依赖标准库 tkinter，Windows 官方 Python 自带）。"""

import tkinter as tk

CELL = 24
BG = "#101820"
WALL = "#546e7a"
SNAKE = "#2ecc71"
HEAD = "#aef5c9"
FOOD = "#ff4757"
TEXT = "#eceff1"
DIM = "#8fa3b0"
FONT = ("Microsoft YaHei", 10)

KEY_DIR = {
    "w": (0, -1), "W": (0, -1), "Up": (0, -1),
    "s": (0, 1), "S": (0, 1), "Down": (0, 1),
    "a": (-1, 0), "A": (-1, 0), "Left": (-1, 0),
    "d": (1, 0), "D": (1, 0), "Right": (1, 0),
}


class SnakeApp:
    """在 Tk 窗口中运行一局贪吃蛇。"""

    def __init__(self, root, game, interval_ms, make_game, speed_name, map_name):
        self.root = root
        self.game = game
        self.interval_ms = interval_ms
        self.make_game = make_game
        self.speed_name = speed_name
        self.map_name = map_name
        self.paused = False
        self._timer = None
        self._closed = False

        self.board_w = game.cols * CELL
        self.board_h = game.rows * CELL

        self.canvas = tk.Canvas(root, width=self.board_w, height=self.board_h,
                                bg=BG, highlightthickness=0)
        self.canvas.pack(side="top")

        self.status = tk.StringVar()
        tk.Label(root, textvariable=self.status, bg=BG, fg=TEXT,
                 font=FONT, anchor="w", padx=8, pady=3).pack(side="top", fill="x")
        tk.Label(root, text="W/A/S/D 或方向键移动    P 暂停    R 重新开始    Q 退出",
                 bg=BG, fg=DIM, font=FONT, anchor="w", padx=8, pady=3).pack(side="top", fill="x")

        root.bind("<KeyPress>", self._on_key)
        root.protocol("WM_DELETE_WINDOW", self._close)

        self._update_status()
        self.draw()
        self._schedule()

    # ---- 主循环 ----
    def _schedule(self):
        if self._closed:
            return
        self._timer = self.root.after(self.interval_ms, self._tick)

    def _tick(self):
        if self._closed:
            return
        self._timer = None
        if not self.paused and not self.game.over:
            self.game.step()
        self._update_status()
        self.draw()
        if not self.game.over:
            self._schedule()

    def _cancel_timer(self):
        if self._timer is not None:
            try:
                self.root.after_cancel(self._timer)
            except Exception:
                pass
            self._timer = None

    # ---- 键盘 ----
    def _on_key(self, event):
        if self._closed:
            return
        k = event.keysym
        if k in ("p", "P", "space", "Space") and not self.game.over:
            self.paused = not self.paused
            if self.paused:
                self._update_status()
                self.draw()
            else:
                self._schedule()
        elif k in ("r", "R"):
            self._cancel_timer()
            self.game = self.make_game()
            self.paused = False
            self._update_status()
            self.draw()
            self._schedule()
        elif k in ("q", "Q", "Escape"):
            self._close()
        elif not self.game.over and not self.paused:
            d = KEY_DIR.get(k)
            if d is not None:
                self.game.queue_direction(d)

    # ---- 绘制 ----
    def _update_status(self):
        g = self.game
        if g.over:
            state = "恭喜通关！" if g.won else "游戏结束"
        elif self.paused:
            state = "已暂停"
        else:
            state = "游戏中"
        self.status.set(f"地图：{self.map_name}    速度：{self.speed_name}"
                        f"    得分：{g.score}    状态：{state}")

    def draw(self):
        c = self.canvas
        c.delete("all")
        g = self.game
        for y in range(g.rows):
            for x in range(g.cols):
                if g.grid[y][x] == "#":
                    c.create_rectangle(x * CELL, y * CELL,
                                       (x + 1) * CELL, (y + 1) * CELL,
                                       fill=WALL, outline="")
        if g.food is not None:
            fx, fy = g.food
            c.create_oval(fx * CELL + 5, fy * CELL + 5,
                          (fx + 1) * CELL - 5, (fy + 1) * CELL - 5,
                          fill=FOOD, outline="")
        for i, (x, y) in enumerate(g.snake):
            fill = HEAD if i == 0 else SNAKE
            c.create_rectangle(x * CELL + 1, y * CELL + 1,
                               (x + 1) * CELL - 1, (y + 1) * CELL - 1,
                               fill=fill, outline="")
        if self.paused:
            self._overlay("已暂停", "按 P 继续")
        elif g.over:
            if g.won:
                self._overlay("恭喜通关！", f"最终得分：{g.score}\n按 R 重新开始，按 Q 退出")
            else:
                self._overlay("游戏结束", f"得分：{g.score}\n按 R 重新开始，按 Q 退出")

    def _overlay(self, title, sub):
        c = self.canvas
        x0, y0, x1, y1 = 10, 10, self.board_w - 10, self.board_h - 10
        c.create_rectangle(x0, y0, x1, y1, fill="#000000", outline="#ffffff", width=2)
        c.create_text(self.board_w // 2, self.board_h // 2 - 10, text=title,
                      fill="#ffffff", font=(FONT[0], 18, "bold"))
        c.create_text(self.board_w // 2, self.board_h // 2 + 26, text=sub,
                      fill="#ffffff", font=FONT)

    def _close(self):
        if self._closed:
            return
        self._closed = True
        self._cancel_timer()
        try:
            self.root.destroy()
        except Exception:
            pass
