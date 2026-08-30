"""预置地图与速度（难度）配置。"""

# 默认棋盘尺寸（宽 x 高）
GRID_COLS = 31
GRID_ROWS = 21

WALL = "#"
EMPTY = " "


def _empty_grid(rows, cols):
    return [[EMPTY] * cols for _ in range(rows)]


def _border(grid):
    rows, cols = len(grid), len(grid[0])
    for c in range(cols):
        grid[0][c] = WALL
        grid[rows - 1][c] = WALL
    for r in range(rows):
        grid[r][0] = WALL
        grid[r][cols - 1] = WALL


def _clear_box(grid, r0, r1, c0, c1):
    """把矩形区域（含边界）内的墙体清空，保证出生点附近可通行。"""
    rows, cols = len(grid), len(grid[0])
    for r in range(max(0, r0), min(rows, r1 + 1)):
        for c in range(max(0, c0), min(cols, c1 + 1)):
            grid[r][c] = EMPTY


def build_classic(rows=GRID_ROWS, cols=GRID_COLS):
    """经典空场：没有墙，蛇穿过边界会从对面出现（环绕模式）。"""
    return _empty_grid(rows, cols)


def build_bordered(rows=GRID_ROWS, cols=GRID_COLS):
    """四周一圈墙，撞墙即死。"""
    grid = _empty_grid(rows, cols)
    _border(grid)
    return grid


def build_cross(rows=GRID_ROWS, cols=GRID_COLS):
    """十字墙体：一竖一横两道主墙，各留缺口，中央为出生区。"""
    grid = _empty_grid(rows, cols)
    _border(grid)
    mid_r, mid_c = rows // 2, cols // 2
    # 竖墙（穿过中列），在约 1/4 高度处留缺口
    for r in range(1, rows - 1):
        if r == rows // 4:
            continue
        grid[r][mid_c] = WALL
    # 横墙（穿过中行），在约 3/4 宽度处留缺口
    for c in range(1, cols - 1):
        if c == (3 * cols) // 4:
            continue
        grid[mid_r][c] = WALL
    # 清空中央出生区
    _clear_box(grid, mid_r - 2, mid_r + 2, mid_c - 4, mid_c + 4)
    return grid


def build_maze(rows=GRID_ROWS, cols=GRID_COLS):
    """简易迷宫：多段水平/竖直短墙，带缺口。"""
    grid = _empty_grid(rows, cols)
    _border(grid)
    mid_r, mid_c = rows // 2, cols // 2
    # 两段水平墙（第 5 行）
    for c in range(2, 13):
        if c == 7:
            continue
        grid[5][c] = WALL
    for c in range(18, 29):
        if c == 23:
            continue
        grid[5][c] = WALL
    # 两段水平墙（第 15 行）
    for c in range(4, 15):
        if c == 9:
            continue
        grid[15][c] = WALL
    for c in range(16, 27):
        if c == 21:
            continue
        grid[15][c] = WALL
    # 一段竖直墙（第 12 列）
    for r in range(8, 17):
        if r in (10, 13):
            continue
        grid[r][12] = WALL
    # 一段竖直墙（第 18 列）
    for r in range(4, 12):
        if r == 7:
            continue
        grid[r][18] = WALL
    # 清空中央出生区
    _clear_box(grid, mid_r - 2, mid_r + 2, mid_c - 4, mid_c + 4)
    return grid


# ----------------------------------------------------------------------
# 地图注册表
# ----------------------------------------------------------------------
MAPS = [
    {
        "id": "classic",
        "name": "经典空场",
        "desc": "没有墙体，穿过边界会从对面出现（环绕）",
        "builder": build_classic,
        "wrap": True,
    },
    {
        "id": "bordered",
        "name": "四边框",
        "desc": "四周有墙，撞墙即死",
        "builder": build_bordered,
        "wrap": False,
    },
    {
        "id": "cross",
        "name": "十字迷宫",
        "desc": "十字形墙体，中央出生区",
        "builder": build_cross,
        "wrap": False,
    },
    {
        "id": "maze",
        "name": "简易迷宫",
        "desc": "多段短墙与缺口组成的迷宫",
        "builder": build_maze,
        "wrap": False,
    },
]

# ----------------------------------------------------------------------
# 难度（速度）配置：interval_ms 为每走一格的时间间隔（毫秒）
# ----------------------------------------------------------------------
SPEEDS = [
    {"name": "简单（慢速）", "interval_ms": 200},
    {"name": "普通", "interval_ms": 130},
    {"name": "困难（快速）", "interval_ms": 85},
    {"name": "地狱（极速）", "interval_ms": 50},
]
