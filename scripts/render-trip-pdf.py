"""Deterministic PDF renderer. Input is an already privacy-filtered Trip on stdin."""
import io
import json
import sys
from xml.sax.saxutils import escape
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from datetime import datetime
from zoneinfo import ZoneInfo
from collections import Counter

pdfmetrics.registerFont(TTFont("TripChinese", sys.argv[1]))
payload = json.load(sys.stdin)
trip, fields = payload["trip"], payload["fields"]
output = io.BytesIO()
style = ParagraphStyle("Body", fontName="TripChinese", fontSize=10, leading=16, spaceAfter=8, wordWrap="CJK", alignment=TA_LEFT, textColor=colors.HexColor("#24352b"))
heading = ParagraphStyle("Heading", parent=style, fontSize=17, leading=24, textColor=colors.HexColor("#245c41"), spaceBefore=8, spaceAfter=14)
small = ParagraphStyle("Small", parent=style, fontSize=8.5, leading=13, textColor=colors.HexColor("#5b6b60"))
story = []
def para(text, header=False):
    story.append(Paragraph(escape(str(text)).replace("\n", "<br/>"), heading if header else style))
def subtle(text):
    story.append(Paragraph(escape(str(text)).replace("\n", "<br/>"), small))
def clock(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(ZoneInfo("Asia/Shanghai")).strftime("%H:%M")
def money(value):
    if value["kind"] == "unknown": return "费用未知（非零）"
    return str(value["amount"]) if value["kind"] == "exact" else f'{value["min"]} - {value["max"]}'
para("北京以外城市同样适用 · 旅行行程" if trip["brief"]["destination"] != "北京" else "北京旅行行程", True)
para(f'AI 辅助生成 | {trip.get("model", "deepseek-v4-pro")} | 版本 {trip["version"]}')
para(f'{trip["brief"]["destination"]} | {trip["brief"]["startDate"]} - {trip["brief"]["endDate"]} | Asia/Shanghai')
if trip.get("preset"): para(trip["preset"]["notice"])
para("不代订、不保证库存。请在出发前复核预约、开放时间、价格和交通。")
status_labels = {"executable": "可执行", "blocked": "有事项待确认", "checked": "已检查", "draft": "草案"}
para("当前状态：" + status_labels.get(trip["lifecycleStatus"], trip["lifecycleStatus"]))
blocking = Counter(alert["message"] for alert in trip["alerts"] if alert["severity"] == "blocking")
if blocking:
    para(f"出发前建议确认 · {sum(blocking.values())} 项（相同问题已合并）", True)
    for message, count in blocking.items():
        para(f"• {message}" + (f"（涉及 {count} 项）" if count > 1 else ""))
for day in trip["days"]:
    story.append(PageBreak())
    para(day["date"] + " · " + day["title"], True)
    entries = [(a["timeWindow"]["start"], "activity", a) for a in day["activities"]] + [(l["departureWindow"]["start"], "leg", l) for l in day["legs"]]
    for _, kind, item in sorted(entries, key=lambda entry: entry[0]):
        if kind == "activity":
            para(f'{clock(item["timeWindow"]["start"])} - {clock(item["timeWindow"]["end"])} | {item["title"]}')
            para(f'{item["place"]["name"]} | {item["importance"]} | {"已锁定" if item["locked"] else "可调整"} | {item["durationMinutes"]} 分钟')
            if item["timeWindow"]["flexibilityMinutes"]: para("弹性时间窗，不代表精确预约时间。")
            if fields["budget"]: para("费用：" + money(item["cost"]))
        else:
            para(f'{clock(item["departureWindow"]["start"])} 交通 {item["mode"]} | {item["durationMinutes"]["min"]} - {item["durationMinutes"]["max"]} 分钟 + 缓冲 {item["bufferMinutes"]} 分钟')
    for note in day["notes"]: para(note)
if fields["budget"]:
    story.append(PageBreak()); para("分类预算", True)
    for item in trip["budget"]["items"]: para(f'{item["title"]} | {item["paymentStatus"]} | {money(item["cost"])}')
    para(f'机动金 {trip["budget"]["contingencyPercent"]}% | 合计 {money(trip["budget"]["total"])}')
story.append(PageBreak()); para("来源与复核提示", True)
status_names = {"verified": "已核验", "recheck_required": "待复核", "failed": "查询失败", "discovery_only": "仅作线索"}
counts = Counter(item["status"] for item in trip["evidence"])
para(" · ".join(f'{status_names.get(status, status)} {count}' for status, count in counts.items()))
seen_sources = set()
for item in trip["evidence"]:
    key = (item["sourceName"], item.get("url"), item["status"])
    if key in seen_sources: continue
    seen_sources.add(key)
    para(f'{item["sourceName"]} | {status_names.get(item["status"], item["status"])} | {item["checkedAt"]}')
    if item.get("url"): subtle(item["url"])
def footer(page, doc):
    page.setFont("TripChinese", 8)
    page.drawString(40, 25, "AI 辅助生成 · 非订单或库存保证")
    page.drawRightString(555, 25, str(doc.page))
class FixedCanvas(canvas.Canvas):
    def __init__(self, *args, **kwargs):
        kwargs["invariant"] = 1
        super().__init__(*args, **kwargs)
        self.setTitle("AI assisted travel itinerary")
        self.setSubject("AI_GENERATED: true; model=" + trip.get("model", "deepseek-v4-pro"))
        self.setAuthor("Travel Agent")
        self.setKeywords("AI_GENERATED, Asia/Shanghai, travel")
doc = SimpleDocTemplate(output, pagesize=(595.28, 841.89), leftMargin=40, rightMargin=40, topMargin=42, bottomMargin=46)
doc.title = "AI assisted travel itinerary"
doc.author = "Travel Agent"
doc.subject = "AI_GENERATED: true; model=" + trip.get("model", "deepseek-v4-pro")
doc.keywords = "AI_GENERATED, Asia/Shanghai, travel"
doc.build(story, onFirstPage=footer, onLaterPages=footer, canvasmaker=FixedCanvas)
sys.stdout.buffer.write(output.getvalue())
