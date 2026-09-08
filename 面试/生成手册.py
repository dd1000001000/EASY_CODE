"""Build the interview handbook. Content is editable in 手册内容.json.
Run with the bundled Python runtime (reportlab, pypdf and Pillow).
"""
from pathlib import Path
import json
from xml.sax.saxutils import escape
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph, Table, TableStyle
from pypdf import PdfReader

HERE = Path(__file__).resolve().parent
DATA = json.loads((HERE / "手册内容.json").read_text(encoding="utf-8"))
OUT = HERE / "EASY_CODE_技术面试准备手册.pdf"
pdfmetrics.registerFont(TTFont("CN", "C:/Windows/Fonts/msyh.ttc", subfontIndex=0))
pdfmetrics.registerFont(TTFont("CNBold", "C:/Windows/Fonts/msyhbd.ttc", subfontIndex=0))
pdfmetrics.registerFontFamily("CN", normal="CN", bold="CNBold", italic="CN", boldItalic="CNBold")
W, H = 595.276, 841.89
M = 47
WIDTH = W - M * 2
NAVY = colors.HexColor("#142B3A")
TEAL = colors.HexColor("#137C80")
INK = colors.HexColor("#283A45")
MUTED = colors.HexColor("#607580")
LIGHT = colors.HexColor("#EEF5F6")
LINE = colors.HexColor("#D7E2E6")
AMBER = colors.HexColor("#8A5A22")

STYLES = {
    "body": ParagraphStyle("body", fontName="CN", fontSize=10.4, leading=17, textColor=INK, wordWrap="CJK", spaceAfter=7),
    "small": ParagraphStyle("small", fontName="CN", fontSize=8.6, leading=13.5, textColor=MUTED, wordWrap="CJK"),
    "label": ParagraphStyle("label", fontName="CNBold", fontSize=10.1, leading=16, textColor=TEAL, wordWrap="CJK"),
    "h2": ParagraphStyle("h2", fontName="CNBold", fontSize=13.5, leading=21, textColor=NAVY, wordWrap="CJK"),
    "title": ParagraphStyle("title", fontName="CNBold", fontSize=21, leading=30, textColor=NAVY, wordWrap="CJK"),
    "cell": ParagraphStyle("cell", fontName="CN", fontSize=9.3, leading=15, textColor=INK, wordWrap="CJK"),
    "mono": ParagraphStyle("mono", fontName="CN", fontSize=8.2, leading=12.5, textColor=MUTED, wordWrap="CJK"),
}
c = canvas.Canvas(str(OUT), pagesize=(W, H), pageCompression=1)
c.setTitle(DATA["title"])
c.setAuthor("EASY CODE 项目面试准备")
c.setSubject("3分钟介绍、24个核心问题、72个追问、回答示范与源码索引")
PAGE = 0
QA = []

def para(text, y, style="body", x=M, width=WIDTH):
    p = Paragraph(escape(text).replace("\n", "<br/>"), STYLES[style])
    _, height = p.wrap(width, H)
    if y - height < 54:
        raise RuntimeError(f"Page {PAGE} overflows: {text[:50]} bottom={y-height}")
    p.drawOn(c, x, y - height)
    QA.append((PAGE, round(y-height, 2), text[:40]))
    return y - height

def start(kicker, title, note="", bookmark=None):
    global PAGE
    if PAGE:
        c.showPage()
    PAGE += 1
    c.setFillColor(TEAL); c.rect(M, H-43, 28, 3, fill=1, stroke=0)
    c.setFont("CN", 8); c.setFillColor(MUTED)
    c.drawString(M+38, H-43, "EASY CODE  /  技术面试准备")
    c.drawRightString(W-M, H-43, kicker)
    c.setStrokeColor(LINE); c.line(M, 42, W-M, 42)
    c.setFont("CN", 7.5); c.drawString(M, 27, "源码快照 2026-09-08  |  回答示范需结合本人真实贡献")
    c.drawRightString(W-M, 27, f"{PAGE:02d}")
    if bookmark:
        c.bookmarkPage(bookmark); c.addOutlineEntry(title, bookmark, 0, False)
    title_breaks = {
        "为什么要做这个项目，而不是直接包装一个聊天 API？": "为什么要做这个项目，\n而不是直接包装一个聊天 API？",
        "多 Provider 怎么扩展，又怎么避免到处写特殊分支？": "多 Provider 怎么扩展，\n又怎么避免到处写特殊分支？",
        "命令执行成功，但写完成事件前崩溃，Resume 怎么办？": "命令执行成功，但写完成事件前崩溃，\nResume 怎么办？",
        "Token 预算怎么计算？多 Agent 同时请求会超支吗？": "Token 预算怎么计算？\n多 Agent 同时请求会超支吗？",
        "Benchmark 为什么 API 能联网，模型命令却不能联网？": "Benchmark 为什么 API 能联网，\n模型命令却不能联网？",
        "CLI 为什么会卡顿？你如何避免 UI 影响 Agent 执行？": "CLI 为什么会卡顿？\n你如何避免 UI 影响 Agent 执行？",
    }
    y = para(title_breaks.get(title, title), H-79, "title") - 12
    if note:
        y = para(note, y, "small") - 17
    return y

def section(label, text, y):
    y = para(label, y, "label") - 4
    return para(text, y) - 14

def box(label, text, y, color=TEAL):
    p = Paragraph(escape(text), STYLES["small"])
    _, ph = p.wrap(WIDTH-26, H)
    height = ph + 42
    if y-height < 56: raise RuntimeError(f"Box overflow on page {PAGE}")
    c.setFillColor(LIGHT); c.roundRect(M, y-height, WIDTH, height, 5, fill=1, stroke=0)
    c.setFillColor(color); c.rect(M, y-height+7, 3, height-14, fill=1, stroke=0)
    c.setFont("CNBold", 9); c.drawString(M+13, y-18, label)
    p.drawOn(c, M+13, y-28-ph)
    return y-height-13

def table(rows, widths, y):
    formatted = [[Paragraph(escape(str(v)), STYLES["cell"]) for v in row] for row in rows]
    t = Table(formatted, colWidths=widths, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("VALIGN", (0,0), (-1,-1), "TOP"), ("BACKGROUND", (0,0), (-1,0), LIGHT),
        ("LINEBELOW", (0,0), (-1,0), .7, LINE), ("LINEBELOW", (0,1), (-1,-1), .35, LINE),
        ("LEFTPADDING", (0,0), (-1,-1), 9), ("RIGHTPADDING", (0,0), (-1,-1), 9),
        ("TOPPADDING", (0,0), (-1,-1), 8), ("BOTTOMPADDING", (0,0), (-1,-1), 8),
    ]))
    _, height = t.wrap(WIDTH, H)
    if y-height < 55: raise RuntimeError(f"Table overflow on page {PAGE}")
    t.drawOn(c, M, y-height)
    return y-height-16

# 01 Cover
PAGE = 1
c.setFillColor(NAVY); c.rect(0, 0, W, H, fill=1, stroke=0)
c.setFillColor(TEAL); c.rect(M, 695, 55, 5, fill=1, stroke=0)
c.setFont("CNBold", 15); c.setFillColor(colors.HexColor("#8BD4D1")); c.drawString(M, 735, "PROJECT INTERVIEW PLAYBOOK")
c.setFont("CNBold", 39); c.setFillColor(colors.white); c.drawString(M, 632, "EASY CODE")
c.setFont("CNBold", 29); c.drawString(M, 584, "技术面试准备手册")
c.setFont("CN", 13); c.setFillColor(colors.HexColor("#CFDFE5")); c.drawString(M, 540, DATA["subtitle"])
for x, big, sub in [(M,"3 分钟","项目介绍口述稿"),(M+174,"24 问","核心问题与示范回答"),(M+348,"72 问","追问与继续回答")]:
    c.setFillColor(colors.HexColor("#8BD4D1")); c.setFont("CNBold", 23); c.drawString(x, 402, big)
    c.setFillColor(colors.white); c.setFont("CN", 10); c.drawString(x, 377, sub)
c.setStrokeColor(colors.HexColor("#48616F")); c.line(M, 327, W-M, 327)
coverstyle = ParagraphStyle("cover", parent=STYLES["body"], textColor=colors.HexColor("#CFDFE5"), fontSize=11, leading=20)
cp = Paragraph("主线：让不确定的模型，在有权限边界、状态证据和预算约束的 Runtime 中工作。<br/><br/>本手册以当前代码和验证记录为依据。已实现机制、已覆盖测试与待验证的效果收益分别表述，不编造准确率、性能提升或个人履历。", coverstyle)
_, ph = cp.wrap(WIDTH, 250); cp.drawOn(c, M, 292-ph)
c.setFont("CN", 9); c.drawString(M, 77, "适用方向：AI Agent 应用开发 / 后端工程 / 工具链与基础设施")
c.drawString(M, 55, "源码快照：2026-09-08    |    项目版本：0.1.0    |    中文练习版")
c.bookmarkPage("cover"); c.addOutlineEntry("封面", "cover", 0, False)

# 02 Contents
y = start("使用方法与导航", "先练主线，再练追问", "建议：先看第 3-5 页，再优先练 Q06、Q08、Q15、Q17、Q24。", "contents")
y = box("回答结构", "结论一句话 → 当前实现 → 真实案例 → 边界与取舍。先回答 45-90 秒，追问时再展开源码；不要一开始就背类名和配置表。", y)
for q in DATA["questions"]:
    page = int(q["id"]) + 5
    y = para(f"{q['id']}  {q['title']}", y, "small", width=WIDTH-27)
    c.setFont("CN", 8.6); c.setFillColor(TEAL); c.drawRightString(W-M, y+2, str(page))
    c.linkRect("", f"q{q['id']}", (M, y-2, W-M, y+15), relative=0, thickness=0)
    y -= 5
y -= 5
y = para("第 30 页：模拟面试与复习路线    第 31 页：源码索引与不能说过头的结论", y, "small")

# 03 Intro
y = start("口述练习", "3 分钟项目介绍", "按自然语速练习；若超过三分钟，先删实现名词，不要删问题、方案和边界。", "intro")
for label, text in DATA["intro"]:
    y = section(label, text, y)
y = box("30 秒备用版本", "EASY CODE 是一个本地优先的 CLI 编程 Agent。我重点做的是可信 Runtime：统一模型工具调用、权限、预算、上下文降级与事件恢复；再用原始验证证据和只读 reviewer 减少长任务重复试错。模型负责提出动作，Runtime 负责决定能否执行、如何恢复和是否有足够证据。", y)

# 04 Architecture
y = start("白板讲解", "用五层架构讲清项目", "先说职责，再说依赖。模型、权限、持久化与 UI 不应互相越权。", "architecture")
y = table([
    ["层", "负责什么", "不能替代什么"],
    ["CLI / TUI", "接收输入、展示正文与 Thinking、菜单和状态", "不直接决定权限或任务完成"],
    ["可信 Runtime", "模式、Schema、预算、调度、事件和恢复", "不把模型声称成功当作事实"],
    ["Provider / 模型目录", "协议转换、能力声明、响应与 usage", "不为每家模型另建安全策略"],
    ["工具 / 执行后端", "读写校验、命令审批、隔离、监督和验证", "Worktree 不能代替 OS 隔离"],
    ["状态 / 记忆 / 检索", "Journal、快照、长期记忆、历史召回", "摘要和检索不能替代原始执行证据"],
], [87, 217, WIDTH-304], y)
y = section("一次请求的顺序", "持久化输入 → 组装上下文与工具 → 预留并记录预算 → 请求模型 → 校验动作与权限 → 执行工具 → 记录结果和观察 → 继续／交付／可恢复暂停。", y)
y = section("三种隔离，分别回答", "Thread 隔离对话上下文；Worktree 隔离源码 Checkout；OS 后端限制进程能力。它们互补，不能把其中一个说成另外两个。", y)
y = box("面试中的关键分界", "事实层：原始执行事件、文件版本和允许的持久记录。建议层：模型方案、reviewer 假设、摘要与 RAG 命中。建议不能自行升级成权限或已验证结论。", y)

# 05 Defaults and claims
y = start("数字速记", "这些数值可以说，但要说对单位", "来自 src/config/runtime-defaults.json；用户配置、恢复状态和适配器可能覆盖默认值。", "numbers")
y = table([
    ["项目", "当前默认", "答题提醒"],
    ["Actor 步数", "none/low/medium: 40；high: 80", "不是全系统总请求次数"],
    ["共享模型请求", "120", "包含父、子及受预算约束的辅助请求"],
    ["上下文字符", "250000", "不是 250000 Token"],
    ["显式 Token 窗口", "0", "未配置额外 Token 上限"],
    ["压缩触发 / 目标", "80% / 55%", "目标是软目标，还要检查实际容量"],
    ["摘要提交 / 字段", "最多 2 次 / 1200 字符", "第二次超长可局部截断"],
    ["摘要输出", "2048 Token", "不同于上下文窗口"],
    ["近期交互优先保留", "2 组", "紧急降级可能减少"],
    ["文件读取", "默认 100 行；最多 1000 行", "另受 12000 估算 Token 限制"],
    ["查询 / 成功 / 失败输出", "12000 / 2000 / 8000 字符", "不是无限 stdout 保存承诺"],
    ["子 Agent 并发", "none/low: 2；medium: 4；high: 8", "按当前强度选择，普通会话主动编排默认关闭"],
    ["调查停滞窗口", "12 响应、至少 5 样本、>70% 重复", "先提醒，后续独立窗口才可审查"],
], [133, 179, WIDTH-312], y)
y = box("验证快照，不是效果宣传", "本次 Harbor 修改的记录：主测试 1065/1065、扩展测试 28/28、适配器测试 6/6，另有真实 Docker 冒烟测试。尚未据此得到新的完整 benchmark 通过率，也不能推导具体 Token 节约百分比。", y)

# 06-29 Question pages
for q in DATA["questions"]:
    y = start(f"Q{q['id']}  /  {q['section']}", q["title"], q["focus"], f"q{q['id']}")
    y = section("建议回答｜先讲这一段", q["answer"], y)
    for i, (question, answer) in enumerate(q["followups"], 1):
        y = para(f"追问 {i:02d}｜{question}", y, "label") - 4
        y = para(answer, y) - 14
    y = box("不要说过头", q["pitfall"], y, AMBER)
    y = para("源码／文档核对", y, "small") - 4
    for source in q["sources"]:
        y = para(source, y, "mono") - 2

# 30 Rehearsal
y = start("复习与实战", "把手册变成能讲出来的答案", "不需要背诵所有句子；要能解释每项设计针对的失败模式。", "practice")
y = table([
    ["30 分钟模拟面试", "练习内容"],
    ["0-3 分钟", "不看稿讲项目介绍，录音检查是否讲清问题与价值。"],
    ["3-8 分钟", "白板讲一次请求生命周期，解释三种隔离和谁拥有权威。"],
    ["8-15 分钟", "选择压缩、恢复或命令隔离，连续回答三层追问。"],
    ["15-22 分钟", "复盘 grep 误判或 Harbor 预检失败：现象、证据、根因、修复、验证。"],
    ["22-27 分钟", "讨论吞吐、成本、误报和安全之间的取舍；提出可测量的下一步。"],
    ["27-30 分钟", "说明个人贡献、AI／开源工具使用方式，以及尚未验证的效果。"],
], [128, WIDTH-128], y)
y = section("面试前 90 分钟复习", "前 20 分钟：3 分钟介绍与架构。中间 40 分钟：Q06、Q08-10、Q15-19、Q24。再用 20 分钟打开对应源码，只核对自己会讲到的分支。最后 10 分钟检查版本、测试口径和个人贡献，不临时编造指标。", y)
y = section("遇到暂时答不出来的问题", "先澄清边界，再说明已知实现与未知部分。例如：‘当前实现对常规测试路径做哈希基线，但没有完整的断言语义分析。我会先构造反例，确认误判类型，再决定是否增加检查，而不是直接声称能识别所有作弊。’", y)
y = box("个人贡献准备清单", "列出你真实负责的需求判断、设计取舍、具体模块、故障定位和验证工作。对 AI 辅助生成的代码，准备说明你怎样审查、做边界测试和处理失败；不要把不能解释的实现包装成完全独立手写。", y)

# 31 Reference map
y = start("源码索引与答题底线", "被追问“代码在哪”时，从这里找", "相对路径均以项目根 F:/coding agent 为基准；源码比旧文档中的历史描述优先。", "sources")
y = table([
    ["主题", "优先阅读"],
    ["请求循环与应用接入", "src/runtime/agent.ts；src/app.ts"],
    ["预算与默认配置", "src/runtime/task-budget.ts；src/config/runtime-defaults.json"],
    ["压缩与容量恢复", "src/context/compaction-transaction.ts；semantic-compaction.ts；pressure-recovery.ts；capacity.ts"],
    ["长期记忆与检索", "src/context/memory-controller.ts；src/memory/memory-manager.ts；vector-index.ts"],
    ["命令执行与验证", "src/command/runtime.ts；verification.ts；normalize-request.ts"],
    ["停滞与实验", "src/progress/guard.ts；observation.ts；experiment.ts；validation-standard.ts"],
    ["Harbor 接入", "src/sandbox/harbor-backend.ts；scripts/harbor-sandbox.c；benchmarks/swebench_verified/easy_code_agent.py"],
    ["协作与结果交付", "src/subagents/coordinator.ts；src/workspace/execution-environment.ts"],
    ["综合文档", "docs/TECHNICAL_DESIGN_ZH.md；PROGRESS_RELIABILITY_ZH.md；COMMAND_SECURITY_ZH.md；LIGHTWEIGHT_RUNTIME.md"],
], [116, WIDTH-116], y)
y = section("四句话必须守住", "1. 有来源不等于已证明，模型建议不等于执行授权。\n2. 日志可恢复不等于任意副作用 exactly-once。\n3. 测试套件通过不等于 benchmark 准确率或成本收益。\n4. 已实现、已验证和未来计划必须分别说明。", y)
y = para("本手册为面试表达与复习材料，不替代项目安全审计。涉及精确性能、准确率、耗时或个人贡献的表述，请在面试前用自己的最新实验记录核实。", y, "small")

c.save()
reader = PdfReader(str(OUT))
assert len(reader.pages) == 31, len(reader.pages)
text = "\n".join(page.extract_text() or "" for page in reader.pages)
assert text.count("追问 01") == 24
assert text.count("追问 02") == 24
assert text.count("追问 03") == 24
for q in DATA["questions"]:
    assert q["title"] in text.replace("\n", ""), q["title"]
assert "\ufffd" not in text
(HERE / "排版校验.json").write_text(json.dumps({"pages": len(reader.pages), "questions": 24,
    "followups": 72, "lowest_text_bottom_pt": min(item[1] for item in QA),
    "output_bytes": OUT.stat().st_size}, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"pdf": str(OUT), "pages": len(reader.pages), "questions": 24, "followups": 72}, ensure_ascii=False))
