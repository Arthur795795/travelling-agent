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

pdfmetrics.registerFont(TTFont("TripChinese", sys.argv[1]))
payload = json.load(sys.stdin)
trip, fields = payload["trip"], payload["fields"]
output = io.BytesIO()
style = ParagraphStyle("Body", fontName="TripChinese", fontSize=10, leading=16, spaceAfter=8, wordWrap="CJK", alignment=TA_LEFT)
heading = ParagraphStyle("Heading", parent=style, fontSize=17, leading=24, textColor=colors.HexColor("#176a68"), spaceAfter=14)
story = []
def para(text, header=False):
    story.append(Paragraph(escape(str(text)).replace("\n", "<br/>"), heading if header else style))
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
para("当前状态：" + trip["lifecycleStatus"])
for alert in trip["alerts"]:
    if alert["severity"] == "blocking": para("待解决：" + alert["message"])
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
for item in trip["evidence"]:
    para(f'{item["sourceName"]} | {item["status"]} | {item["checkedAt"]}')
    if item.get("url"): para(item["url"])
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
