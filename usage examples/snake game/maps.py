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


def _hline(grid, r, c0, c1, gaps=()):
    """横向墙体：第 r 行、c0..c1 列，gaps 为要留口的列号。"""
    for c in range(c0, c1 + 1):
        if c in gaps:
            continue
        grid[r][c] = WALL


def _vline(grid, c, r0, r1, gaps=()):
    """纵向墙体：第 c 列、r0..r1 行，gaps 为要留口的行号。"""
    for r in range(r0, r1 + 1):
        if r in gaps:
            continue
        grid[r][c] = WALL


def _rect(grid, r0, r1, c0, c1, gaps=()):
    """矩形边框。gaps 为 (方向, 起, 止) 三元组，方向取 't'/'b'/'l'/'r'。"""
    for c in range(c0, c1 + 1):
        if not any(g[0] == "t" and g[1] <= c <= g[2] for g in gaps):
            grid[r0][c] = WALL
        if not any(g[0] == "b" and g[1] <= c <= g[2] for g in gaps):
            grid[r1][c] = WALL
    for r in range(r0 + 1, r1):
        if not any(g[0] == "l" and g[1] <= r <= g[2] for g in gaps):
            grid[r][c0] = WALL
        if not any(g[0] == "r" and g[1] <= r <= g[2] for g in gaps):
            grid[r][c1] = WALL


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


def build_rooms(rows=GRID_ROWS, cols=GRID_COLS):
    """房间迷宫：两条竖墙、一条横墙隔出六个房间，隔墙开有门洞。"""
    grid = _empty_grid(rows, cols)
    _border(grid)
    mid_r, mid_c = rows // 2, cols // 2
    # 两条竖直隔墙，各开两个门洞
    _vline(grid, 10, 1, rows - 2, gaps=(4, 5, 15, 16))
    _vline(grid, 20, 1, rows - 2, gaps=(6, 7, 12, 13))
    # 一条水平隔墙，门洞开在两侧，中央留作出生区
    _hline(grid, 10, 1, cols - 2, gaps=(4, 5, 25, 26))
    _clear_box(grid, mid_r - 2, mid_r + 2, mid_c - 4, mid_c + 4)
    return grid


def build_spiral(rows=GRID_ROWS, cols=GRID_COLS):
    """螺旋迷宫：四圈方环由外向内旋进，只有一条通路通向中央。"""
    grid = _empty_grid(rows, cols)
    _border(grid)
    mid_r, mid_c = rows // 2, cols // 2
    # 缺口依次开在：下、左、上、右，形成一条螺旋通路
    _rect(grid, 2, 18, 2, 28, gaps=(("b", 13, 15),))
    _rect(grid, 4, 16, 4, 26, gaps=(("l", 8, 10),))
    _rect(grid, 6, 14, 6, 24, gaps=(("t", 16, 18),))
    _rect(grid, 8, 12, 8, 22, gaps=(("r", 9, 11),))
    # 中央出生区（在第四圈内部）
    _clear_box(grid, mid_r - 1, mid_r + 1, mid_c - 3, mid_c + 3)
    return grid


def build_diagonal(rows=GRID_ROWS, cols=GRID_COLS):
    """斜线迷阵：两条斜墙交叉成 X，中央广场为出生区。"""
    grid = _empty_grid(rows, cols)
    _border(grid)
    mid_r, mid_c = rows // 2, cols // 2
    for r in range(1, rows - 1):
        c1 = mid_c - (mid_r - r)   # 左上 → 右下
        c2 = mid_c + (mid_r - r)   # 右上 → 左下
        if 0 < c1 < cols - 1:
            grid[r][c1] = WALL
        if c2 != c1 and 0 < c2 < cols - 1:
            grid[r][c2] = WALL
    # 中央广场（两条斜墙的交点区域）
    _clear_box(grid, mid_r - 2, mid_r + 2, mid_c - 4, mid_c + 4)
    return grid


def build_serpentine(rows=GRID_ROWS, cols=GRID_COLS):
    """S 形走廊：四条横向短墙交错留口，蛇必须左右迂回。"""
    grid = _empty_grid(rows, cols)
    _border(grid)
    mid_r, mid_c = rows // 2, cols // 2
    # 左段墙 → 右段墙 → 左段墙 → 右段墙，缺口交替
    _hline(grid, 4, 2, 13)
    _hline(grid, 8, 17, 28)
    _hline(grid, 12, 2, 13)
    _hline(grid, 16, 17, 28)
    # 出生区位于中间横向带
    _clear_box(grid, mid_r - 1, mid_r + 1, mid_c - 2, mid_c + 2)
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
    {
        "id": "rooms",
        "name": "房间迷宫",
        "desc": "六个带门洞的房间，中央出生区",
        "builder": build_rooms,
        "wrap": False,
    },
    {
        "id": "spiral",
        "name": "螺旋迷宫",
        "desc": "四圈方环由外向内旋进，只有一条通路",
        "builder": build_spiral,
        "wrap": False,
    },
    {
        "id": "diagonal",
        "name": "斜线迷阵",
        "desc": "两条斜墙交叉成 X，中央广场出生区",
        "builder": build_diagonal,
        "wrap": False,
    },
    {
        "id": "serpentine",
        "name": "S 形走廊",
        "desc": "横向短墙交错留口，蛇必须左右迂回",
        "builder": build_serpentine,
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
