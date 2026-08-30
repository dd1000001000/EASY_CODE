"""贪吃蛇核心逻辑。

纯逻辑模块，不依赖任何图形界面，方便单元测试与复用。
坐标约定：x 向右为正，y 向下为正；蛇头在 snake[0]，尾部在 snake[-1]。
"""

import random


class Game:
    """一局贪吃蛇游戏的状态与规则。"""

    def __init__(self, grid, wrap=False, start=None, rng=None):
        # 拷贝网格，避免调用方后续修改影响游戏
        self.grid = [list(row) for row in grid]
        self.rows = len(self.grid)
        self.cols = len(self.grid[0]) if self.rows else 0
        self.wrap = wrap
        self.rng = rng if rng is not None else random
        self.score = 0
        self.over = False
        self.won = False

        if start is None:
            start = (self.cols // 2, self.rows // 2)
        sx, sy = start
        # 蛇头在前，初始长度为 3，朝右移动
        self.snake = [(sx - i, sy) for i in range(3)]
        self.direction = (1, 0)      # 当前实际方向
        self.pending = []            # 待处理的方向（最多缓冲 2 个，支持快速连按）
        self.food = None
        self._place_food()

    # ------------------------------------------------------------------
    # 查询
    # ------------------------------------------------------------------
    def is_wall(self, x, y):
        """判断 (x, y) 是否为墙（或出界）。环绕地图永远没有墙。"""
        if self.wrap:
            return False
        if x < 0 or y < 0 or x >= self.cols or y >= self.rows:
            return True
        return self.grid[y][x] == "#"

    def _free_cells(self):
        """返回所有可以放置食物的空格子。"""
        cells = []
        occupied = set(self.snake)
        for y in range(self.rows):
            for x in range(self.cols):
                if (x, y) in occupied:
                    continue
                if self.grid[y][x] == "#":
                    continue
                cells.append((x, y))
        return cells

    def _place_food(self):
        """随机放一个食物；若没有空格子则判为通关。"""
        cells = self._free_cells()
        if not cells:
            self.won = True
            self.over = True
            self.food = None
            return
        self.food = self.rng.choice(cells)

    # ------------------------------------------------------------------
    # 操作
    # ------------------------------------------------------------------
    def queue_direction(self, direction):
        """排入一个移动方向；禁止 180 度掉头，最多缓冲 2 个方向。"""
        if self.over:
            return
        dx, dy = direction
        if dx == 0 and dy == 0:
            return
        last = self.pending[-1] if self.pending else self.direction
        if (dx, dy) == (-last[0], -last[1]):
            return
        if len(self.pending) < 2:
            self.pending.append((dx, dy))

    def step(self):
        """前进一步。返回事件字符串：'ok' / 'over' / 'win'。"""
        if self.over:
            return "over"
        if self.pending:
            self.direction = self.pending.pop(0)

        hx, hy = self.snake[0]
        dx, dy = self.direction
        nx, ny = hx + dx, hy + dy
        if self.wrap:
            nx %= self.cols
            ny %= self.rows

        grows = (nx, ny) == self.food

        if self.is_wall(nx, ny):
            self.over = True
            return "over"

        # 撞到自己：尾巴即将移走，所以最后一个格子不算障碍（除非本步要长身体）
        body = self.snake[:-1] if not grows else self.snake
        if (nx, ny) in body:
            self.over = True
            return "over"

        self.snake.insert(0, (nx, ny))
        if grows:
            self.score += 1
            self._place_food()
            if self.over:
                return "win"
        else:
            self.snake.pop()
        return "ok"
