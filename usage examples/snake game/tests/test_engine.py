"""贪吃蛇核心逻辑单元测试。

运行方式（在 snake game 目录下）：
    python -m unittest discover -s tests -v
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import Game
from maps import MAPS, SPEEDS, GRID_ROWS, GRID_COLS


class FixedRng:
    """按给定顺序返回食物坐标，用完后取第一个可用格子。"""

    def __init__(self, cells):
        self.cells = list(cells)

    def choice(self, seq):
        if self.cells:
            return self.cells.pop(0)
        return seq[0]


class TestBasics(unittest.TestCase):
    def test_initial_state(self):
        g = Game([[" "] * 10 for _ in range(10)], rng=FixedRng([(9, 9)]))
        self.assertEqual(len(g.snake), 3)
        self.assertEqual(g.direction, (1, 0))
        self.assertFalse(g.over)
        self.assertFalse(g.won)
        self.assertIsNotNone(g.food)
        self.assertEqual(g.food, (9, 9))

    def test_move_forward(self):
        g = Game([[" "] * 10 for _ in range(10)], rng=FixedRng([(9, 9)]))
        head = g.snake[0]
        g.step()
        self.assertEqual(g.snake[0], (head[0] + 1, head[1]))
        self.assertFalse(g.over)

    def test_reverse_ignored(self):
        g = Game([[" "] * 10 for _ in range(10)], rng=FixedRng([(9, 9)]))
        g.queue_direction((-1, 0))  # 朝右时想直接掉头，应被忽略
        g.step()
        self.assertEqual(g.snake[0], (6, 5))  # 起点 (5,5) 朝右，第一步到 (6,5)
        self.assertFalse(g.over)

    def test_double_turn_buffer(self):
        g = Game([[" "] * 10 for _ in range(10)], rng=FixedRng([(9, 9)]))
        # 朝右：快速连按“下”和“左”
        g.queue_direction((0, 1))
        g.queue_direction((-1, 0))
        g.step()
        g.step()
        # 第一步向下到 (5,6)，第二步向左到 (4,6)
        self.assertEqual(g.snake[0], (4, 6))
        self.assertFalse(g.over)

    def test_wall_collision(self):
        g = Game([[" "] * 6 for _ in range(4)], rng=FixedRng([(0, 3)]))
        for _ in range(10):
            g.step()
        self.assertTrue(g.over)


class TestFood(unittest.TestCase):
    def test_eat_and_grow(self):
        grid = [[" "] * 8 for _ in range(4)]
        g = Game(grid, rng=FixedRng([(6, 2)]))
        # 蛇头起点 (4,2)，食物在 (6,2)
        g.step()  # 到 (5,2)
        g.step()  # 到 (6,2) 吃到
        self.assertEqual(g.score, 1)
        self.assertEqual(len(g.snake), 4)
        self.assertIsNotNone(g.food)  # 又放入了新食物

    def test_food_not_on_wall(self):
        for m in MAPS:
            grid = m["builder"]()
            g = Game(grid, wrap=m["wrap"], rng=FixedRng([]))
            self.assertIsNotNone(g.food, m["id"])
            fx, fy = g.food
            self.assertEqual(g.grid[fy][fx], " ", m["id"])


class TestCollision(unittest.TestCase):
    def test_self_collision(self):
        grid = [[" "] * 7 for _ in range(7)]
        g = Game(grid, rng=FixedRng([(6, 0)]))
        g.snake = [(3, 3), (3, 2), (2, 2), (2, 3)]
        g.direction = (0, -1)  # 向上会撞到身体 (3,2)
        g.step()
        self.assertTrue(g.over)
        self.assertEqual(g.score, 0)


class TestWrap(unittest.TestCase):
    def test_wrap_around(self):
        grid = [[" "] * 5 for _ in range(5)]
        g = Game(grid, wrap=True, rng=FixedRng([(0, 4)]))
        g.queue_direction((0, 1))
        g.step()  # (2,3)
        g.step()  # (2,4)
        g.step()  # (2,0) 环绕出现
        self.assertEqual(g.snake[0], (2, 0))
        self.assertFalse(g.over)


class TestWin(unittest.TestCase):
    def test_win_when_board_full(self):
        grid = [[" "] * 4 for _ in range(2)]  # 共 8 格
        g = Game(grid, rng=FixedRng([(3, 1)]))
        # 蛇占 7 格，食物在第 8 格 (3,1)
        g.snake = [(2, 1), (1, 1), (0, 1), (0, 0), (1, 0), (2, 0), (3, 0)]
        g.direction = (1, 0)
        result = g.step()
        self.assertEqual(result, "win")
        self.assertTrue(g.won)
        self.assertTrue(g.over)


class TestMaps(unittest.TestCase):
    def test_maps_size(self):
        for m in MAPS:
            grid = m["builder"]()
            self.assertEqual(len(grid), GRID_ROWS, m["id"])
            for row in grid:
                self.assertEqual(len(row), GRID_COLS, m["id"])

    def test_spawn_area_clear(self):
        for m in MAPS:
            grid = m["builder"]()
            g = Game(grid, wrap=m["wrap"])
            for x, y in g.snake:
                self.assertEqual(g.grid[y][x], " ", f"{m['id']} 出生点被墙体占用")

    def test_speeds_defined(self):
        self.assertGreaterEqual(len(SPEEDS), 2)
        for s in SPEEDS:
            self.assertGreater(s["interval_ms"], 0)


if __name__ == "__main__":
    unittest.main()
