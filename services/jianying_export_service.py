#!/usr/bin/env python3
"""
剪映草稿导出服务（ContentMaster AI）
macOS / Windows 双平台支持
功能：
  - 自动下载图片/音频到本地草稿目录
  - 生成剪映 5.9 兼容主脚本（根目录 draft_info.json / draft_content.json：materials + tracks）
  - 自动在 Finder 中显示导出目录
"""
import sys
import os
import json
import uuid
import time
import shutil
import subprocess
import platform
import tempfile
import re
import random
from pathlib import Path
from datetime import datetime
from urllib.parse import urlparse

# ---- 跨平台工具函数 ----

def get_platform() -> str:
    return platform.system()


def get_mac_draft_dir() -> str:
    """获取 macOS 剪映草稿目录（需要完全磁盘访问权限）"""
    return str(Path.home() / "Movies" / "JianyingPro" / "User Data" / "Projects" / "com.lveditor.draft")


def _get_writable_output_dir() -> str:
    """获取可写入的输出目录（按优先级尝试）"""
    candidates = [
        str(Path.home() / "Movies" / "ContentMaster_Exports"),
        str(Path.home() / "Documents" / "ContentMaster_Exports"),
        str(Path.home() / "Desktop" / "ContentMaster_Exports"),
    ]
    for candidate in candidates:
        try:
            os.makedirs(candidate, exist_ok=True)
            test_file = os.path.join(candidate, '.write_test')
            with open(test_file, 'w') as f:
                f.write('test')
            os.remove(test_file)
            return candidate
        except Exception:
            continue
    # 最终 fallback：项目目录
    script_dir = os.path.dirname(os.path.abspath(__file__))
    output_dir = os.path.join(script_dir, 'exports')
    try:
        os.makedirs(output_dir, exist_ok=True)
    except Exception:
        pass
    return output_dir


def _safe_filename(url: str) -> str:
    """从 URL 生成安全的本地文件名（支持 data: URL）"""
    if url.startswith("blob:"):
        return f"media_{uuid.uuid4().hex[:10]}.mp4"
    if url.startswith('data:'):
        # data:image/png;base64,... → 从 mime type 推断扩展名
        import re as _re
        mime_match = _re.search(r'data:([^;]+)', url)
        ext_map = {
            'image/png': '.png',
            'image/jpeg': '.jpg',
            'image/jpg': '.jpg',
            'image/gif': '.gif',
            'image/webp': '.webp',
            'audio/wav': '.wav',
            'audio/mpeg': '.mp3',
            'audio/mp3': '.mp3',
            'audio/mp4': '.m4a',
            'audio/x-m4a': '.m4a',
            'audio/flac': '.flac',
            'audio/ogg': '.ogg',
            'video/mp4': '.mp4',
            'video/quicktime': '.mov',
            'video/webm': '.webm',
        }
        mime = mime_match.group(1) if mime_match else 'application/octet-stream'
        ext = ext_map.get(mime, '.bin')
        return f"media_{uuid.uuid4().hex[:8]}{ext}"

    parsed = urlparse(url)
    name = os.path.basename(parsed.path)
    if not name or len(name) > 80:
        name = f"media_{uuid.uuid4().hex[:8]}"
    # 去掉危险字符
    name = re.sub(r'[\\/:*?"<>|]', '_', name)
    return name


def _download_file(url: str, dest_path: str, timeout: int = 30) -> bool:
    """下载文件到本地，支持 http/https/data:"""
    try:
        if url.startswith('data:'):
            # data:image/png;base64,iVBORw0KG...
            header, data = url.split(',', 1)
            import base64
            # 提取 mime type
            mime_match = re.search(r'data:([^;]+)', header)
            ext = '.png'
            if mime_match:
                mime = mime_match.group(1)
                ext_map = {
                    'image/png': '.png',
                    'image/jpeg': '.jpg',
                    'image/jpg': '.jpg',
                    'image/gif': '.gif',
                    'image/webp': '.webp',
                    'audio/wav': '.wav',
                    'audio/mpeg': '.mp3',
                    'audio/mp3': '.mp3',
                    'audio/mp4': '.m4a',
                    'audio/x-m4a': '.m4a',
                    'audio/flac': '.flac',
                    'audio/ogg': '.ogg',
                    'video/mp4': '.mp4',
                    'video/quicktime': '.mov',
                    'video/webm': '.webm',
                }
                ext = ext_map.get(mime, ext)
            # 如果文件没有扩展名，加上推断的扩展名
            if '.' not in os.path.basename(dest_path):
                dest_path += ext
            binary_data = base64.b64decode(data)
            with open(dest_path, 'wb') as f:
                f.write(binary_data)
            return True

        # HTTP/HTTPS 下载（RunningHub 等站点常校验 Referer，无则 403）
        import urllib.request
        headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        }
        if 'runninghub.cn' in url.lower():
            headers['Referer'] = 'https://www.runninghub.cn/'
            timeout = max(timeout, 90)
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as response:
            content_type = response.headers.get('Content-Type', '')
            # 根据 Content-Type 自动推断扩展名
            if '.' not in os.path.basename(dest_path):
                ct_map = {
                    'image/png': '.png',
                    'image/jpeg': '.jpg',
                    'image/jpg': '.jpg',
                    'image/gif': '.gif',
                    'image/webp': '.webp',
                    'video/mp4': '.mp4',
                    'video/quicktime': '.mov',
                    'audio/wav': '.wav',
                    'audio/wave': '.wav',
                    'audio/x-wav': '.wav',
                    'audio/mpeg': '.mp3',
                    'audio/mp3': '.mp3',
                    'audio/mp4': '.m4a',
                    'audio/x-m4a': '.m4a',
                    'audio/flac': '.flac',
                    'audio/ogg': '.ogg',
                }
                ext = ct_map.get(content_type.split(';')[0].strip(), '')
                if ext:
                    dest_path += ext
            with open(dest_path, 'wb') as f:
                shutil.copyfileobj(response, f)
        return True
    except Exception as e:
        print(f"[WARN] 下载失败 {url}: {e}", file=sys.stderr)
        return False


def _reveal_in_finder(path: str):
    subprocess.run(["open", "-R", path], check=False, capture_output=True, timeout=10)


def _normalize_jianying_path(path: str) -> str:
    """规范写入草稿 JSON 的路径，避免出现 /app/C:\\... 这类前缀污染。"""
    p = (path or "").strip()
    if not p:
        return p

    # 1) Linux 容器里对 Windows 盘符路径做了 abspath，会变成 /app/C:\... → 还原为 C:\...
    m = re.match(r"^/[^/]+/([A-Za-z]:[\\/].*)$", p)
    if m:
        p = m.group(1)

    # 2) 兜底：直接 /C:\... 或 /D:/... 也还原
    p = re.sub(r"^/([A-Za-z]:[\\/])", r"\1", p)

    # 3) Windows 盘符路径统一反斜杠
    if re.match(r"^[A-Za-z]:[\\/]", p):
        p = p.replace('/', '\\')

    return p


def _safe_abs_for_jianying(path: str) -> str:
    """生成供剪映写入的路径：Windows 盘符路径不做 abspath，其他路径取绝对并规范。"""
    p = (path or "").strip()
    if re.match(r"^[A-Za-z]:[\\/]", p):
        return _normalize_jianying_path(p)
    return _normalize_jianying_path(os.path.abspath(p))


def _write_png_rgb(path: str, w: int, h: int, r: int, g: int, b: int) -> bool:
    """写入纯色 RGB PNG（8-bit）。"""
    try:
        import struct, zlib

        def _crc(data):
            return zlib.crc32(data) & 0xffffffff

        w = max(1, min(int(w), 4096))
        h = max(1, min(int(h), 4096))
        sig = b"\x89PNG\r\n\x1a\n"
        ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
        ihdr_crc = _crc(b"IHDR" + ihdr)
        raw = b""
        row = b"\x00" + bytes([r, g, b] * w)
        for _ in range(h):
            raw += row
        compressed = zlib.compress(raw, 6)
        idat_crc = _crc(b"IDAT" + compressed)
        iend_crc = _crc(b"IEND")
        png_data = (
            sig
            + struct.pack(">I", 13)
            + b"IHDR"
            + ihdr
            + struct.pack(">I", ihdr_crc)
            + struct.pack(">I", len(compressed))
            + b"IDAT"
            + compressed
            + struct.pack(">I", idat_crc)
            + struct.pack(">I", 0)
            + b"IEND"
            + struct.pack(">I", iend_crc)
        )
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "wb") as f:
            f.write(png_data)
        return True
    except Exception:
        return False


def _generate_cover(draft_folder: str, width: int, height: int):
    """生成草稿封面（纯色 PNG，扩展名与内容一致，避免 .jpg 内写 PNG 导致剪映无法识别）"""
    cover_path = os.path.join(draft_folder, "draft_cover.png")
    max_side = 360
    if width > 0 and height > 0:
        scale = min(max_side / max(width, height), 1.0)
        tw, th = max(1, int(width * scale)), max(1, int(height * scale))
    else:
        tw, th = 320, 180
    _write_png_rgb(cover_path, tw, th, 24, 24, 28)


def _placeholder_shot_image_path(draft_folder: str, index: int, canvas_w: int, canvas_h: int) -> str:
    """无图镜头：生成小尺寸占位 PNG，返回绝对路径。"""
    path = os.path.join(draft_folder, "Resources", "image", f"_placeholder_shot_{index}.png")
    cw, ch = max(1, canvas_w), max(1, canvas_h)
    scale = min(640.0 / max(cw, ch), 1.0)
    tw, th = max(2, int(cw * scale)), max(2, int(ch * scale))
    if not _write_png_rgb(path, tw, th, 32, 32, 40):
        _write_png_rgb(path, 320, 180, 32, 32, 40)
    return os.path.abspath(path)


def _open_jianying_pro():
    """尝试打开剪映专业版（macOS）"""
    if get_platform() != "Darwin":
        return "非 macOS，跳过"
    app_names = [
        "JianyingPro",
        "剪映专业版",
        "/Applications/JianyingPro.app",
        str(Path.home() / "Applications" / "JianyingPro.app"),
    ]
    for app in app_names:
        try:
            if app.startswith("/"):
                subprocess.run(["open", app], check=True, capture_output=True, timeout=10)
                return f"已打开: {app}"
            else:
                subprocess.run(["open", "-a", app], check=True, capture_output=True, timeout=10)
                return f"已打开应用: {app}"
        except Exception:
            continue
    return "未找到剪映专业版，请手动打开"


def _timestamp_us() -> int:
    return int(time.time() * 1_000_000)


def _make_id() -> str:
    return str(uuid.uuid4()).upper()


def _read_image_dimensions(path: str, fallback_w: int, fallback_h: int) -> tuple:
    """读取 PNG/JPEG 宽高，失败则返回画布尺寸。"""
    try:
        with open(path, "rb") as f:
            head = f.read(32)
        if len(head) >= 24 and head[:8] == b"\x89PNG\r\n\x1a\n":
            import struct
            w, h = struct.unpack(">II", head[16:24])
            if w > 0 and h > 0:
                return w, h
        if len(head) >= 2 and head[:2] == b"\xff\xd8":
            with open(path, "rb") as f:
                data = f.read()
            i = 2
            while i + 9 < len(data):
                if data[i] != 0xFF:
                    break
                marker = data[i + 1]
                if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                    h = (data[i + 5] << 8) | data[i + 6]
                    w = (data[i + 7] << 8) | data[i + 8]
                    if w > 0 and h > 0:
                        return w, h
                seg_len = (data[i + 2] << 8) | data[i + 3]
                i += 2 + seg_len
    except Exception:
        pass
    return fallback_w, fallback_h


def _ffprobe_duration_us(path: str):
    """音频/视频时长（微秒），失败返回 None。部分 FLAC 仅 stream 有 duration，format 会为 N/A。"""
    try:
        r = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-show_entries",
                "stream=duration",
                "-of",
                "json",
                path,
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if r.returncode != 0 or not (r.stdout or "").strip():
            return None
        data = json.loads(r.stdout or "{}")
        fmt = data.get("format") or {}
        fd = float(fmt.get("duration") or 0)
        if fd > 0:
            return max(1, int(fd * 1_000_000))
        best = 0.0
        for s in data.get("streams") or []:
            d = float(s.get("duration") or 0)
            if d > best:
                best = d
        if best > 0:
            return max(1, int(best * 1_000_000))
    except Exception:
        pass
    return None


def _ffprobe_video_meta(path: str):
    """返回 (duration_us, width, height)，失败则为 (None, 0, 0)。"""
    try:
        r = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-show_entries",
                "format=duration",
                "-of",
                "json",
                path,
            ],
            capture_output=True,
            text=True,
            timeout=90,
        )
        if r.returncode != 0:
            return None, 0, 0
        data = json.loads(r.stdout or "{}")
        st = (data.get("streams") or [{}])[0]
        fmt = data.get("format") or {}
        w = int(st.get("width") or 0)
        h = int(st.get("height") or 0)
        d = float(fmt.get("duration") or 0)
        du = max(33_333, int(d * 1_000_000)) if d > 0 else None
        return du, w, h
    except Exception:
        return None, 0, 0


# 视频入场动画（pyJianYingDraft metadata/video_intro，免费项；duration_us 与元数据一致）
_LV59_INTRO_ANIMATION_PRESETS = [
    {"name": "动感放大", "effect_id": "6740867832570974733", "resource_id": "431662", "duration_us": 500_000},
    {"name": "渐显", "effect_id": "6798320778182922760", "resource_id": "624705", "duration_us": 500_000},
    {"name": "放大", "effect_id": "6798332733694153230", "resource_id": "624751", "duration_us": 500_000},
    {"name": "缩小", "effect_id": "6798332584276267527", "resource_id": "624755", "duration_us": 500_000},
    {"name": "旋转", "effect_id": "6798334070653719054", "resource_id": "624731", "duration_us": 500_000},
    {"name": "向上滑动", "effect_id": "6798333487523828238", "resource_id": "624739", "duration_us": 500_000},
    {"name": "向下滑动", "effect_id": "6798333705401143816", "resource_id": "624735", "duration_us": 500_000},
    {"name": "轻微放大", "effect_id": "6800268825611735559", "resource_id": "629085", "duration_us": 500_000},
]

# 视频画面特效（video_effect，对应 pyJianYingDraft VideoEffect；免费项）
_LV59_VIDEO_EFFECT_PRESETS = [
    # ("名称", effect_id, resource_id, 参数列表)
    # 参数为空列表时 adjust_params 为 []
    ("kirakira", "6706773500142555656", "693883", []),
    ("CCD闪光", "7130585796020539941", "4007303", [
        {"param_key": "effects_adjust_speed", "param_value": 0.5},
        {"param_key": "effects_adjust_luminance", "param_value": 0.65},
        {"param_key": "effects_adjust_background_animation", "param_value": 0.5},
        {"param_key": "effects_adjust_filter", "param_value": 0.95},
    ]),
    ("丁达尔光线", "6834008866137575950", "768190", [
        {"param_key": "effects_adjust_speed", "param_value": 0.33},
        {"param_key": "effects_adjust_background_animation", "param_value": 1.0},
    ]),
    ("ktv灯光", "6771299914891661832", "634197", [
        {"param_key": "effects_adjust_speed", "param_value": 0.33},
        {"param_key": "effects_adjust_background_animation", "param_value": 1.0},
    ]),
    ("70s", "6706773500792689165", "634717", [
        {"param_key": "effects_adjust_speed", "param_value": 0.33},
    ]),
    ("DV录制框", "6878115805498708493", "934600", [
        {"param_key": "effects_adjust_speed", "param_value": 0.33},
        {"param_key": "effects_adjust_blur", "param_value": 0.5},
        {"param_key": "effects_adjust_filter", "param_value": 1.0},
        {"param_key": "effects_adjust_sharpen", "param_value": 0.2},
    ]),
    ("RGB描边", "6922698007653650957", "1025970", [
        {"param_key": "effects_adjust_speed", "param_value": 0.67},
        {"param_key": "effects_adjust_horizontal_shift", "param_value": 1.0},
        {"param_key": "effects_adjust_vertical_shift", "param_value": 0.5},
    ]),
    ("VCR", "6876012864679711245", "931458", [
        {"param_key": "effects_adjust_speed", "param_value": 0.33},
        {"param_key": "effects_adjust_sharpen", "param_value": 0.3},
        {"param_key": "effects_adjust_filter", "param_value": 1.0},
        {"param_key": "effects_adjust_horizontal_chromatic", "param_value": 0.6},
        {"param_key": "effects_adjust_vertical_chromatic", "param_value": 0.5},
    ]),
]

# 转场（来自 pyJianYingDraft TransitionMeta，默认免费项；与剪映内置转场一致）
# 结构：(名称, effect_id, resource_id, duration_us, is_overlap)
_LV59_TRANSITION_PRESETS = [
    ("叠化", "6724845717472416269", "322577", 500_000, True),
    ("分割", "6968372308419285540", "4211683", 500_000, True),
    ("向上擦除", "6724849456891564557", "2917281", 500_000, True),
    ("向右擦除", "6724849898857959950", "2917284", 500_000, True),
    ("开幕", "6750893890712113677", "391781", 500_000, True),
    ("闪回", "7250427149318885945", "16638473", 200_000, True),
    ("3D空间", "7049979667406656014", "1506926", 1_500_000, True),
    ("上移", "6724846395116753416", "2917279", 500_000, True),
    ("下移", "6724849276100284942", "2917280", 500_000, True),
    ("中心旋转", "6858191434294497805", "878914", 500_000, False),
    ("动漫云朵", "6777178865119793678", "2911876", 500_000, False),
    ("动漫漩涡", "6858191448827761160", "878913", 500_000, False),
    ("动漫闪电", "6777178696609436174", "2911874", 500_000, False),
    ("倒影", "6748313807031898627", "369691", 500_000, True),
    ("冰雪结晶", "6919369228701143559", "1017910", 500_000, False),
    ("冲鸭", "7030714241359286821", "1441672", 500_000, False),
    ("云朵", "6955722927161479694", "2912469", 500_000, True),
]

# 滤镜素材（filter，对应 pyJianYingDraft Filter；免费项）
# 结构：(名称, effect_id, resource_id)
_LV59_FILTER_PRESETS = [
    ("亮肤", "7127655008715230495", "7127655008715230495"),
    ("冷白", "7127614731187178783", "7127614731187178783"),
    ("低保真", "7304170509661506843", "7304170509661506843"),
    ("仲夏绿光", "7127675970252754189", "7127675970252754189"),
    ("ABG", "7127679308897832206", "7127679308897832206"),
    ("VHS III", "7127669764905782542", "7127669764905782542"),
    ("亢奋", "7166472327801097476", "7166472327801097476"),
    ("三洋VPC", "7127669338089311495", "7127669338089311495"),
]


def _split_caption_into_natural_chunks(text: str, max_chars: int = 28) -> list[str]:
    """按句读切分字幕，并在无标点长句时强制分块，避免整段粘连。"""
    t = " ".join((text or "").strip().split())
    if not t:
        return []

    def _force_wrap(raw: str, limit: int) -> list[str]:
        s = (raw or "").strip()
        if not s:
            return []
        buf, arr = "", []
        for ch in s:
            buf += ch
            if len(buf) >= limit:
                arr.append(buf.strip())
                buf = ""
        if buf.strip():
            arr.append(buf.strip())
        return arr

    parts = re.split(r"(?<=[。！？．.!?])\s*", t)
    chunks: list[str] = []
    for piece in parts:
        piece = piece.strip()
        if not piece:
            continue
        if len(piece) <= max_chars:
            chunks.append(piece)
            continue

        sub = re.split(r"(?<=[，,；;：:])\s*", piece)
        buf = ""
        for s in sub:
            s = s.strip()
            if not s:
                continue
            if len(s) > max_chars:
                if buf:
                    chunks.append(buf)
                    buf = ""
                chunks.extend(_force_wrap(s, max_chars))
                continue
            if not buf:
                buf = s
            elif len(buf) + len(s) <= max_chars:
                buf = buf + s
            else:
                chunks.append(buf)
                buf = s
        if buf:
            chunks.append(buf)

    out: list[str] = []
    for c in chunks:
        c = c.strip()
        if not c:
            continue
        if len(c) > max_chars:
            out.extend(_force_wrap(c, max_chars))
            continue
        if out and len(c) < 5:
            out[-1] = out[-1] + c
        else:
            out.append(c)
    return out if out else _force_wrap(t, max_chars)


def _distribute_chunk_durations_us(chunks: list[str], total_duration_us: int, min_chunk_us: int = 120_000) -> list[int]:
    """按字符权重把本镜总时长分到各字幕块，保证每块至少 min_chunk_us（约 0.12s）。"""
    n = len(chunks)
    if n <= 0:
        return []
    total = max(33_333, int(total_duration_us))
    if n == 1:
        return [total]
    min_need = min_chunk_us * n
    if total < min_need:
        min_chunk_us = max(33_333, total // n)
        min_need = min_chunk_us * n
    weights = [max(1, len(re.sub(r"\s+", "", c))) for c in chunks]
    tw = sum(weights)
    alloc: list[int] = []
    used = 0
    for i, w in enumerate(weights):
        if i == n - 1:
            last = max(min_chunk_us, total - used)
            alloc.append(last)
            break
        raw = int(round(total * w / tw))
        d = max(min_chunk_us, raw)
        remaining = n - i - 1
        max_here = total - used - min_chunk_us * remaining
        d = min(d, max(max_here, min_chunk_us))
        d = max(min_chunk_us, d)
        alloc.append(d)
        used += d
    drift = total - sum(alloc)
    if drift != 0:
        alloc[-1] = max(min_chunk_us, alloc[-1] + drift)
    return alloc


def _build_video_intro_animation_json(spec: dict, clip_duration_us: int) -> dict:
    """单段入场动画，结构与 pyJianYingDraft.animation.VideoAnimation.export_json 一致。"""
    dur = int(spec["duration_us"])
    dur = min(dur, max(200_000, int(clip_duration_us * 0.35)))
    dur = max(200_000, dur)
    return {
        "anim_adjust_params": None,
        "platform": "all",
        "panel": "video",
        "material_type": "video",
        "name": spec["name"],
        "id": spec["effect_id"],
        "type": "in",
        "resource_id": spec["resource_id"],
        "start": 0,
        "duration": dur,
    }


def _load_lv59_template() -> dict:
    tpl_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "jianying_draft_content_template.json")
    with open(tpl_path, "r", encoding="utf-8") as f:
        return json.load(f)


def _build_lv59_main_script(
    draft_id: str,
    now_us: int,
    width: int,
    height: int,
    fps: int,
    total_duration: int,
    prepared_shots: list,
    draft_display_name: str = "",
    random_transitions: bool = False,
    random_filters: bool = False,
) -> dict:
    """
    剪映专业版 5.9 macOS 主时间线格式：根目录 draft_info.json / draft_content.json
    使用 materials + tracks（与 pyJianYingDraft 模板一致），不能用仅 timelines/entity_list 的旧格式。
    """
    content = _load_lv59_template()
    mats = content["materials"]
    for k in mats:
        if isinstance(mats[k], list):
            mats[k] = []

    video_track_id = _make_id()
    audio_track_id = _make_id()
    text_track_id = _make_id()

    video_segments = []
    audio_segments = []
    text_segments = []
    # 记录每个镜头「最后一个 segment」在 video_segments 中的下标（用于在镜头边界处挂转场/特效）
    shot_last_seg_idx: list[int] = []
    # 每个镜头最后一个 segment 的视频时长（秒），用于转场时长上限
    shot_last_seg_dur: list[int] = []

    for row in prepared_shots:
        start_us = row["start_us"]
        dur_us = row["duration_us"]
        media_kind = row.get("media_kind") or "photo"
        if media_kind == "video":
            media_path = row["video_abs"]
            iw, ih = int(row["video_w"]), int(row["video_h"])
            mat_duration = int(row.get("video_material_duration_us") or dur_us)
            is_video = True
        else:
            media_path = row["image_abs"]
            iw, ih = int(row["image_w"]), int(row["image_h"])
            mat_duration = 10800000000
            is_video = False
        has_tts = bool(row.get("audio_abs") and os.path.isfile(str(row.get("audio_abs"))))
        base_name = os.path.basename(media_path)

        vid_mat_id = _make_id()
        mats["videos"].append(
            {
                "aigc_type": "none",
                "audio_fade": None,
                "cartoon_path": "",
                "category_id": "",
                "category_name": "local",
                "check_flag": 63487,
                "crop": {
                    "lower_left_x": 0.0,
                    "lower_left_y": 1.0,
                    "lower_right_x": 1.0,
                    "lower_right_y": 1.0,
                    "upper_left_x": 0.0,
                    "upper_left_y": 0.0,
                    "upper_right_x": 1.0,
                    "upper_right_y": 0.0,
                },
                "crop_ratio": "free",
                "crop_scale": 1.0,
                "duration": mat_duration,
                "extra_type_option": 0,
                "formula_id": "",
                "freeze": None,
                "has_audio": is_video,
                "height": ih,
                "id": vid_mat_id,
                "intensifies_audio_path": "",
                "intensifies_path": "",
                "is_ai_generate_content": False,
                "is_copyright": False,
                "is_text_edit_overdub": False,
                "is_unified_beauty_mode": False,
                "local_id": "",
                "local_material_id": "",
                "material_id": "",
                "material_name": base_name,
                "material_url": "",
                "matting": {
                    "flag": 0,
                    "has_use_quick_brush": False,
                    "has_use_quick_eraser": False,
                    "interactiveTime": [],
                    "path": "",
                    "strokes": [],
                },
                "media_path": "",
                "object_locked": None,
                "origin_material_id": "",
                "path": media_path,
                "picture_from": "none",
                "picture_set_category_id": "",
                "picture_set_category_name": "",
                "request_id": "",
                "reverse_intensifies_path": "",
                "reverse_path": "",
                "smart_motion": None,
                "source": 0,
                "source_platform": 0,
                "stable": {
                    "matrix_path": "",
                    "stable_level": 0,
                    "time_range": {"duration": 0, "start": 0},
                },
                "team_id": "",
                "type": "video" if is_video else "photo",
                "video_algorithm": {
                    "algorithms": [],
                    "complement_frame_config": None,
                    "deflicker": None,
                    "gameplay_configs": [],
                    "motion_blur_config": None,
                    "noise_reduction": None,
                    "path": "",
                    "quality_enhance": None,
                    "time_range": None,
                },
                "width": iw,
            }
        )

        def _append_one_video_segment(
            *,
            t_start: int,
            src_dur: int,
            tgt_dur: int,
            vol: float,
            intro_clip_us=None,
        ) -> None:
            sp_id = _make_id()
            cv_id = _make_id()
            ma_id = _make_id()
            scm_id = _make_id()
            vs_id = _make_id()
            mats["speeds"].append({"curve_speed": None, "id": sp_id, "mode": 0, "speed": 1.0, "type": "speed"})
            mats["canvases"].append(
                {
                    "album_image": "",
                    "blur": 0.0,
                    "color": "",
                    "id": cv_id,
                    "image": "",
                    "image_id": "",
                    "image_name": "",
                    "source_platform": 0,
                    "team_id": "",
                    "type": "canvas_color",
                }
            )
            video_ani_list: list = []
            if intro_clip_us is not None and (random_transitions or random_filters):
                _aspec = random.choice(_LV59_INTRO_ANIMATION_PRESETS)
                video_ani_list.append(_build_video_intro_animation_json(_aspec, intro_clip_us))
            mats["material_animations"].append(
                {"animations": video_ani_list, "id": ma_id, "multi_language_current": "none", "type": "sticker_animation"}
            )
            mats["sound_channel_mappings"].append(
                {"audio_channel_mapping": 0, "id": scm_id, "is_config_open": False, "type": "none"}
            )
            mats["vocal_separations"].append(
                {"choice": 0, "id": vs_id, "production_path": "", "time_range": None, "type": "vocal_separation"}
            )
            vseg_id = _make_id()
            video_segments.append(
                {
                    "caption_info": None,
                    "cartoon": False,
                    "clip": {
                        "alpha": 1.0,
                        "flip": {"horizontal": False, "vertical": False},
                        "rotation": 0.0,
                        "scale": {"x": 1.0, "y": 1.0},
                        "transform": {"x": 0.0, "y": 0.0},
                    },
                    "common_keyframes": [],
                    "enable_adjust": True,
                    "enable_color_correct_adjust": False,
                    "enable_color_curves": True,
                    "enable_color_match_adjust": False,
                    "enable_color_wheels": True,
                    "enable_lut": True,
                    "enable_smart_color_adjust": False,
                    "extra_material_refs": [sp_id, cv_id, ma_id, scm_id, vs_id],
                    "group_id": "",
                    "hdr_settings": {"intensity": 1.0, "mode": 1, "nits": 1000},
                    "id": vseg_id,
                    "intensifies_audio": False,
                    "is_placeholder": False,
                    "is_tone_modify": False,
                    "keyframe_refs": [],
                    "last_nonzero_volume": 1.0,
                    "material_id": vid_mat_id,
                    "render_index": 0,
                    "responsive_layout": {
                        "enable": False,
                        "horizontal_pos_layout": 0,
                        "size_layout": 0,
                        "target_follow": "",
                        "vertical_pos_layout": 0,
                    },
                    "reverse": False,
                    "source_timerange": {"start": 0, "duration": src_dur},
                    "speed": 1.0,
                    "target_timerange": {"start": t_start, "duration": tgt_dur},
                    "template_id": "",
                    "template_scene": "default",
                    "track_attribute": 0,
                    "track_render_index": 0,
                    "uniform_scale": {"on": True, "value": 1.0},
                    "visible": True,
                    "volume": vol,
                }
            )

        if not is_video:
            src_dur = max(33_333, int(dur_us))
            _append_one_video_segment(
                t_start=int(start_us),
                src_dur=src_dur,
                tgt_dur=src_dur,
                vol=1.0,
                intro_clip_us=int(dur_us),
            )
            shot_last_seg_idx.append(len(video_segments) - 1)
            shot_last_seg_dur.append(int(dur_us))
        else:
            # 视频短于配音/镜头槽位时：多段首尾相接循环铺滿整条 duration_us，每段 source==target、speed=1，无慢放也无黑屏
            mat_d = max(33_333, int(mat_duration) if mat_duration else int(dur_us))
            slot_d = max(33_333, int(dur_us))
            pos = int(start_us)
            remain = slot_d
            chunk_i = 0
            vol = 0.0 if has_tts else 1.0
            while remain > 33_333:
                chunk = min(remain, mat_d)
                intro_us = chunk if chunk_i == 0 else None
                _append_one_video_segment(
                    t_start=pos,
                    src_dur=chunk,
                    tgt_dur=chunk,
                    vol=vol,
                    intro_clip_us=intro_us,
                )
                pos += chunk
                remain -= chunk
                chunk_i += 1
            # 记录本镜「最后一个 segment」：用于镜头边界转场
            shot_last_seg_idx.append(len(video_segments) - 1)
            # 最后一小段时长 = chunk（小）或 remain 刚好归零说明整除
            last_seg_d = chunk if remain <= 33_333 and chunk_i > 0 else mat_d
            shot_last_seg_dur.append(int(last_seg_d))

        apath = row.get("audio_abs")
        if apath and os.path.isfile(apath):
            probe_adur = row.get("audio_duration_us")
            if probe_adur and int(probe_adur) > 0:
                adur = int(probe_adur)
            else:
                adur = int(dur_us)
            adur = max(adur, int(dur_us))
            aud_mat_id = _make_id()
            lm = uuid.uuid4().hex
            music_id = str(uuid.uuid4())
            mats["audios"].append(
                {
                    "app_id": 0,
                    "category_id": "",
                    "category_name": "local",
                    "check_flag": 1,
                    "copyright_limit_type": "none",
                    "duration": adur,
                    "effect_id": "",
                    "formula_id": "",
                    "id": aud_mat_id,
                    "intensifies_path": "",
                    "is_ai_clone_tone": False,
                    "is_text_edit_overdub": False,
                    "is_ugc": False,
                    "local_material_id": lm,
                    "music_id": music_id,
                    "name": os.path.basename(apath),
                    "path": apath,
                    "query": "",
                    "request_id": "",
                    "resource_id": "",
                    "search_id": "",
                    "source_from": "",
                    "source_platform": 0,
                    "team_id": "",
                    "text_id": "",
                    "tone_category_id": "",
                    "tone_category_name": "",
                    "tone_effect_id": "",
                    "tone_effect_name": "",
                    "tone_platform": "",
                    "tone_second_category_id": "",
                    "tone_second_category_name": "",
                    "tone_speaker": "",
                    "tone_type": "",
                    "type": "extract_music",
                    "video_id": "",
                    "wave_points": [],
                }
            )
            asp_id = _make_id()
            beat_id = _make_id()
            ascm_id = _make_id()
            avs_id = _make_id()
            mats["speeds"].append({"curve_speed": None, "id": asp_id, "mode": 0, "speed": 1.0, "type": "speed"})
            mats["beats"].append(
                {
                    "ai_beats": {
                        "beat_speed_infos": [],
                        "beats_path": "",
                        "beats_url": "",
                        "melody_path": "",
                        "melody_percents": [0.0],
                        "melody_url": "",
                    },
                    "enable_ai_beats": False,
                    "gear": 404,
                    "gear_count": 0,
                    "id": beat_id,
                    "mode": 404,
                    "type": "beats",
                    "user_beats": [],
                    "user_delete_ai_beats": None,
                }
            )
            mats["sound_channel_mappings"].append(
                {"audio_channel_mapping": 0, "id": ascm_id, "is_config_open": False, "type": "none"}
            )
            mats["vocal_separations"].append(
                {"choice": 0, "id": avs_id, "production_path": "", "time_range": None, "type": "vocal_separation"}
            )
            aseg_id = _make_id()
            # 音频只取真实素材时长，避免 target 长于 source 时尾部出现噪声/破音
            use_src = max(33_333, int(adur))
            # 轨道长度以音频真实时长为准（有配音时），由视频轨决定总时间线
            audio_target_dur = use_src
            audio_segments.append(
                {
                    "caption_info": None,
                    "cartoon": False,
                    "clip": None,
                    "common_keyframes": [],
                    "enable_adjust": False,
                    "enable_color_correct_adjust": False,
                    "enable_color_curves": True,
                    "enable_color_match_adjust": False,
                    "enable_color_wheels": True,
                    "enable_lut": False,
                    "enable_smart_color_adjust": False,
                    "extra_material_refs": [asp_id, beat_id, ascm_id, avs_id],
                    "group_id": "",
                    "hdr_settings": None,
                    "id": aseg_id,
                    "intensifies_audio": False,
                    "is_placeholder": False,
                    "is_tone_modify": False,
                    "keyframe_refs": [],
                    "last_nonzero_volume": 1.0,
                    "material_id": aud_mat_id,
                    "render_index": 0,
                    "responsive_layout": {
                        "enable": False,
                        "horizontal_pos_layout": 0,
                        "size_layout": 0,
                        "target_follow": "",
                        "vertical_pos_layout": 0,
                    },
                    "reverse": False,
                    "source_timerange": {"start": 0, "duration": use_src},
                    "speed": 1.0,
                    "target_timerange": {"start": start_us, "duration": audio_target_dur},
                    "template_id": "",
                    "template_scene": "default",
                    "track_attribute": 0,
                    "track_render_index": 0,
                    "uniform_scale": None,
                    "visible": True,
                    "volume": 1.0,
                }
            )

        cap = (row.get("caption") or "").strip()
        if cap:
            cap_chunks = _split_caption_into_natural_chunks(cap)
            _floor_us = 33_333
            while len(cap_chunks) > 1 and int(dur_us) < _floor_us * len(cap_chunks):
                cap_chunks[-2] = (cap_chunks[-2] + cap_chunks[-1]).strip()
                cap_chunks.pop()
            chunk_durs = _distribute_chunk_durations_us(cap_chunks, dur_us)
            t_cursor = start_us
            for ci, chunk in enumerate(cap_chunks):
                cdu = chunk_durs[ci] if ci < len(chunk_durs) else max(33_333, dur_us - (t_cursor - start_us))
                txt_mat_id = _make_id()
                txt_anim_id = _make_id()
                mats["material_animations"].append(
                    {
                        "animations": [],
                        "id": txt_anim_id,
                        "multi_language_current": "none",
                        "type": "sticker_animation",
                    }
                )
                content_obj = {
                    "styles": [
                        {
                            "fill": {
                                "alpha": 1.0,
                                "content": {
                                    "render_type": "solid",
                                    "solid": {"alpha": 1.0, "color": [1.0, 1.0, 1.0]},
                                },
                            },
                            "range": [0, len(chunk)],
                            "size": 8.0,
                            "bold": False,
                            "italic": False,
                            "underline": False,
                            "strokes": [],
                        }
                    ],
                    "text": chunk,
                }
                mats["texts"].append(
                    {
                        "id": txt_mat_id,
                        "content": json.dumps(content_obj, ensure_ascii=False),
                        "typesetting": 0,
                        "alignment": 1,
                        "letter_spacing": 0.0,
                        "line_spacing": 0.02,
                        "line_feed": 1,
                        "line_max_width": 0.82,
                        "force_apply_line_max_width": False,
                        "check_flag": 7,
                        "type": "subtitle",
                        "global_alpha": 1.0,
                    }
                )
                tseg_id = _make_id()
                text_segments.append(
                    {
                        "caption_info": None,
                        "cartoon": False,
                        "clip": {
                            "alpha": 1.0,
                            "flip": {"horizontal": False, "vertical": False},
                            "rotation": 0.0,
                            "scale": {"x": 1.0, "y": 1.0},
                            "transform": {"x": 0.0, "y": -0.8},
                        },
                        "common_keyframes": [],
                        "enable_adjust": True,
                        "enable_color_correct_adjust": False,
                        "enable_color_curves": True,
                        "enable_color_match_adjust": False,
                        "enable_color_wheels": True,
                        "enable_lut": True,
                        "enable_smart_color_adjust": False,
                        "extra_material_refs": [txt_anim_id],
                        "group_id": "",
                        "hdr_settings": {"intensity": 1.0, "mode": 1, "nits": 1000},
                        "id": tseg_id,
                        "intensifies_audio": False,
                        "is_placeholder": False,
                        "is_tone_modify": False,
                        "keyframe_refs": [],
                        "last_nonzero_volume": 1.0,
                        "material_id": txt_mat_id,
                        "render_index": 15000,
                        "responsive_layout": {
                            "enable": False,
                            "horizontal_pos_layout": 0,
                            "size_layout": 0,
                            "target_follow": "",
                            "vertical_pos_layout": 0,
                        },
                        "reverse": False,
                        "source_timerange": None,
                        "speed": 1.0,
                        "target_timerange": {"start": t_cursor, "duration": cdu},
                        "template_id": "",
                        "template_scene": "default",
                        "track_attribute": 0,
                        "track_render_index": 0,
                        "uniform_scale": {"on": True, "value": 1.0},
                        "visible": True,
                        "volume": 1.0,
                    }
                )
                t_cursor += cdu

    # ── 调试日志：输出特效/转场写入情况 ──
    _trans_count = sum(1 for t in mats.get("transitions", []) if t.get("type") == "transition")
    _filt_count = len(mats.get("filters", []))
    _vfx_count = len(mats.get("video_effects", []))
    print(
        f"[jianying_export] segments={len(video_segments)}, shots={len(prepared_shots)}, "
        f"transitions={_trans_count}, filters={_filt_count}, video_effects={_vfx_count}"
    )
    # ── 转场：只挂在「镜头边界」的前一个 segment 上（多段循环拼接只在最后一段之后转场）
    # 转场时长不超过前一个镜头末段的实际时长，避免越界
    if random_transitions and len(shot_last_seg_idx) > 1:
        for s in range(1, len(shot_last_seg_idx)):
            prev_shot_last = shot_last_seg_idx[s - 1]
            seg = video_segments[prev_shot_last]
            t_range = seg.get("target_timerange", {})
            seg_dur = t_range.get("duration", 0) if isinstance(t_range, dict) else 0
            name, eff_id, res_id, dur_us_t, is_ov = random.choice(_LV59_TRANSITION_PRESETS)
            # 转场时长不超过前一个镜头末段时长（防止越界）
            real_dur = min(dur_us_t, int(seg_dur) if seg_dur else 500_000)
            tid = _make_id()
            mats["transitions"].append(
                {
                    "category_id": "",
                    "category_name": "",
                    "duration": real_dur,
                    "effect_id": eff_id,
                    "id": tid,
                    "is_overlap": is_ov,
                    "name": name,
                    "platform": "all",
                    "resource_id": res_id,
                    "type": "transition",
                }
            )
            video_segments[prev_shot_last]["extra_material_refs"].append(tid)

    # 滤镜 / 视频特效：只在每个镜头「第一个」segment 上应用（多段拼接时只在开头）
    if random_filters and shot_last_seg_idx:
        mats.setdefault("filters", [])
        mats.setdefault("video_effects", [])

        # 每个镜头的第一个 segment：下标 = shot_last_seg_idx[i-1] + 1（首个镜头用 0）
        first_seg_of_shot: list[int] = []
        for k in range(len(shot_last_seg_idx)):
            if k == 0:
                first_seg_of_shot.append(0)
            else:
                first_seg_of_shot.append(shot_last_seg_idx[k - 1] + 1)

        for seg_idx in first_seg_of_shot:
            if seg_idx >= len(video_segments):
                continue
            seg = video_segments[seg_idx]
            # ── 滤镜素材 ──
            f_name, f_eff_id, f_res_id = random.choice(_LV59_FILTER_PRESETS)
            fid = _make_id()
            mats["filters"].append(
                {
                    "adjust_params": [],
                    "algorithm_artifact_path": "",
                    "apply_target_type": 0,
                    "bloom_params": None,
                    "category_id": "",
                    "category_name": "",
                    "color_match_info": {
                        "source_feature_path": "",
                        "target_feature_path": "",
                        "target_image_path": "",
                    },
                    "effect_id": f_eff_id,
                    "enable_skin_tone_correction": False,
                    "exclusion_group": [],
                    "face_adjust_params": [],
                    "formula_id": "",
                    "id": fid,
                    "intensity_key": "",
                    "multi_language_current": "",
                    "name": f_name,
                    "panel_id": "",
                    "platform": "all",
                    "resource_id": f_res_id,
                    "source_platform": 1,
                    "sub_type": "none",
                    "time_range": None,
                    "type": "filter",
                    "value": 1.0,
                    "version": "",
                }
            )
            seg["extra_material_refs"].append(fid)

            # ── 视频画面特效（效果更明显）──
            fx_name, fx_eff_id, fx_res_id, fx_params = random.choice(_LV59_VIDEO_EFFECT_PRESETS)
            vfx_id = _make_id()
            adjust_params = [
                {
                    "param_key": p["param_key"],
                    "param_value": p["param_value"],
                }
                for p in fx_params
            ]
            mats["video_effects"].append(
                {
                    "adjust_params": adjust_params,
                    "apply_target_type": 0,
                    "apply_time_range": None,
                    "category_id": "",
                    "category_name": "",
                    "common_keyframes": [],
                    "disable_effect_faces": [],
                    "effect_id": fx_eff_id,
                    "formula_id": "",
                    "id": vfx_id,
                    "name": fx_name,
                    "platform": "all",
                    "render_index": 11000,
                    "resource_id": fx_res_id,
                    "source_platform": 0,
                    "time_range": None,
                    "track_render_index": 0,
                    "type": "video_effect",
                    "value": 1.0,
                    "version": "",
                }
            )
            seg["extra_material_refs"].append(vfx_id)

    tracks = []
    if video_segments:
        tracks.append(
            {
                "attribute": 0,
                "flag": 0,
                "id": video_track_id,
                "is_default_name": True,
                "name": "",
                "segments": video_segments,
                "type": "video",
            }
        )
    if audio_segments:
        tracks.append(
            {
                "attribute": 0,
                "flag": 0,
                "id": audio_track_id,
                "is_default_name": True,
                "name": "",
                "segments": audio_segments,
                "type": "audio",
            }
        )
    if text_segments:
        tracks.append(
            {
                "attribute": 0,
                "flag": 0,
                "id": text_track_id,
                "is_default_name": True,
                "name": "",
                "segments": text_segments,
                "type": "text",
            }
        )

    content["id"] = draft_id
    content["name"] = draft_display_name or ""
    content["duration"] = total_duration
    content["fps"] = float(fps)
    content["create_time"] = now_us
    content["update_time"] = now_us
    content["canvas_config"] = {"width": width, "height": height, "ratio": "original"}
    content["tracks"] = tracks
    plat = {
        "app_id": 3704,
        "app_source": "lv",
        "app_version": "5.9.0",
        "device_id": "",
        "hard_disk_id": "",
        "mac_address": "",
        "os": "mac",
        "os_version": "",
    }
    content["last_modified_platform"] = plat
    content["platform"] = plat
    return content


# ---- 核心草稿生成 ----

def create_draft_on_mac(
    draft_name: str,
    shots: list,
    output_dir: str = None,
    fps: int = 30,
    width: int = 1920,
    height: int = 1080,
    random_transitions: bool = False,
    random_filters: bool = False,
) -> dict:
    """
    创建剪映草稿：
      1. 建立目录结构
      2. 下载每个镜头的图片/音频到本地
      3. 写入根目录 draft_info.json 与 draft_content.json（剪映 5.9 主时间线格式）
    """
    # 调试信息必须写 stderr，stdout 仅用于 JSON（否则 Node 会把整段 stdout 当响应体）
    for i, shot in enumerate(shots):
        audio_url = shot.get("audioUrl") or shot.get("voiceoverAudioUrl")
        image_url = shot.get("imageUrl") or (shot.get("imageUrls", [None])[0] if shot.get("imageUrls") else None)
        vu = shot.get("videoUrls")
        video_url = shot.get("videoUrl") or shot.get("video_url")
        if vu and isinstance(vu, list) and len(vu) > 0:
            video_url = vu[-1]
        print(
            f"[jianying_export] 镜头{i}: video={bool(video_url and str(video_url).strip())}, audio={bool(audio_url and str(audio_url).strip())}, image={bool(image_url and str(image_url).strip())}",
            file=sys.stderr,
            flush=True,
        )
    if output_dir is None:
        output_dir = get_mac_draft_dir()

    # ---- 建立目录 ----
    safe_name = "".join(c for c in draft_name if c not in '/\\:*?"<>|').strip() or "未命名"
    draft_folder_name = safe_name
    draft_folder = os.path.join(output_dir, draft_folder_name)
    counter = 1
    while os.path.exists(draft_folder):
        draft_folder_name = f"{safe_name}_{counter}"
        draft_folder = os.path.join(output_dir, draft_folder_name)
        counter += 1

    def _ensure_dirs():
        os.makedirs(draft_folder, exist_ok=True)
        os.makedirs(os.path.join(draft_folder, "Timelines"), exist_ok=True)
        os.makedirs(os.path.join(draft_folder, "Resources"), exist_ok=True)
        os.makedirs(os.path.join(draft_folder, "Resources", "videoAlg"), exist_ok=True)
        os.makedirs(os.path.join(draft_folder, "Resources", "audioAlg"), exist_ok=True)
        os.makedirs(os.path.join(draft_folder, "Resources", "digitalHuman"), exist_ok=True)
        os.makedirs(os.path.join(draft_folder, "Resources", "restore_lut"), exist_ok=True)
        os.makedirs(os.path.join(draft_folder, "Resources", "broll"), exist_ok=True)
        os.makedirs(os.path.join(draft_folder, "Resources", "broll", "default"), exist_ok=True)
        os.makedirs(os.path.join(draft_folder, "Resources", "image"), exist_ok=True)
        os.makedirs(os.path.join(draft_folder, "Resources", "video"), exist_ok=True)
        os.makedirs(os.path.join(draft_folder, "Resources", "audio"), exist_ok=True)
        os.makedirs(os.path.join(draft_folder, "Resources", "text"), exist_ok=True)
        os.makedirs(os.path.join(draft_folder, "adjust_mask"), exist_ok=True)
        # 新增：剪映要求的其他目录
        os.makedirs(os.path.join(draft_folder, "matting"), exist_ok=True)
        os.makedirs(os.path.join(draft_folder, "qr_upload"), exist_ok=True)
        os.makedirs(os.path.join(draft_folder, "smart_crop"), exist_ok=True)
        os.makedirs(os.path.join(draft_folder, "subdraft"), exist_ok=True)
        os.makedirs(os.path.join(draft_folder, "common_attachment"), exist_ok=True)

    try:
        _ensure_dirs()
    except OSError as e:
        if e.errno == 1:  # Operation not permitted
            output_dir = _get_writable_output_dir()
            draft_folder_name = safe_name
            draft_folder = os.path.join(output_dir, draft_folder_name)
            counter = 1
            while os.path.exists(draft_folder):
                draft_folder_name = f"{safe_name}_{counter}"
                draft_folder = os.path.join(output_dir, draft_folder_name)
                counter += 1
            try:
                _ensure_dirs()
            except Exception:
                pass  # 尽力而为
        else:
            raise

    draft_id = _make_id()
    now_us = _timestamp_us()
    timeline_id = _make_id()

    # ---- 下载资源，组装剪映 5.9 主脚本所需镜头行（绝对路径）----
    prepared_shots: list[dict] = []
    timeline_cursor = 0
    for i, shot in enumerate(shots):
        base_dur = int(float(shot.get("duration", 5)) * 1_000_000)
        start_us = timeline_cursor

        vu = shot.get("videoUrls")
        video_url = shot.get("videoUrl") or shot.get("video_url")
        if vu and isinstance(vu, list) and len(vu) > 0:
            video_url = vu[-1]

        use_video = False
        local_video_path = None
        if video_url and str(video_url).strip():
            vname = _safe_filename(str(video_url))
            if not re.search(r"\.(mp4|mov|webm|m4v)$", vname, re.I):
                vname = f"{vname}.mp4" if "." not in vname else re.sub(r"[^.]+$", "mp4", vname)
            local_video_path = os.path.join(draft_folder, "Resources", "video", vname)
            if _download_file(str(video_url), local_video_path):
                use_video = True
            else:
                local_video_path = None

        duration_us = base_dur
        row: dict = {
            "start_us": start_us,
            "duration_us": duration_us,
            "caption": (shot.get("caption") or "").strip(),
            "audio_abs": None,
            "audio_duration_us": None,
        }

        if use_video and local_video_path:
            vabs = _safe_abs_for_jianying(local_video_path)
            vd, vw, vh = _ffprobe_video_meta(vabs)
            if vd:
                duration_us = vd
            row["media_kind"] = "video"
            row["video_abs"] = vabs
            row["video_w"] = vw or width
            row["video_h"] = vh or height
            row["video_material_duration_us"] = vd or duration_us
            row["duration_us"] = duration_us
        else:
            image_url = shot.get("imageUrl") or (shot.get("imageUrls", [None])[0] if shot.get("imageUrls") else None)
            local_image_path = None
            if image_url and str(image_url).strip():
                img_filename = _safe_filename(str(image_url))
                local_image_path = os.path.join(draft_folder, "Resources", "image", img_filename)
                if not _download_file(str(image_url), local_image_path):
                    local_image_path = None
            if not local_image_path:
                local_image_path = _placeholder_shot_image_path(draft_folder, i, width, height)
            img_abs = _safe_abs_for_jianying(local_image_path)
            iw, ih = _read_image_dimensions(img_abs, width, height)
            row["media_kind"] = "photo"
            row["image_abs"] = img_abs
            row["image_w"] = iw
            row["image_h"] = ih

        audio_url = shot.get("audioUrl") or shot.get("voiceoverAudioUrl")
        client_audio_us = None
        for _k in ("audioDurationSec", "audio_duration_sec"):
            v = shot.get(_k)
            if v is not None:
                try:
                    sec = float(v)
                    if sec > 0:
                        client_audio_us = max(1, int(sec * 1_000_000))
                except (TypeError, ValueError):
                    pass
                break

        if audio_url and str(audio_url).strip():
            audio_filename = _safe_filename(str(audio_url))
            lap = os.path.join(draft_folder, "Resources", "audio", audio_filename)
            ok = _download_file(str(audio_url), lap)
            print(f"[jianying_export] 镜头{i} 音频: url={'有' if audio_url else '无'} → 文件={audio_filename} → 下载={'成功' if ok else '失败'} {'(' + str(audio_url)[:80] + ')' if audio_url else ''}", file=sys.stderr, flush=True)
            if ok:
                row["audio_abs"] = _safe_abs_for_jianying(lap)
                probe_us = _ffprobe_duration_us(row["audio_abs"])
                # 以文件实测为准；客户端 audioDurationSec 多为文案估算，取 max 会把时间线拉长得远超真实波形（见 pyJianYingDraft：片段时长应对齐素材）。
                if probe_us:
                    row["audio_duration_us"] = int(probe_us)
                else:
                    row["audio_duration_us"] = client_audio_us
                # 有配音时：时间线镜头时长以音频为准（静态图 / 视频片段不再固定 5s）
                ad = row.get("audio_duration_us")
                if ad and int(ad) > 0:
                    row["duration_us"] = int(ad)
            else:
                # 下载失败但客户端提供了时长估算（如前端 TTS），以此作时长兜底
                if client_audio_us and int(client_audio_us) > 0:
                    row["audio_duration_us"] = int(client_audio_us)
                    row["duration_us"] = int(client_audio_us)

        prepared_shots.append(row)
        timeline_cursor += row["duration_us"]

    # 调试：汇总每个镜头的音频信息
    for i, r in enumerate(prepared_shots):
        print(f"[jianying_export] 镜头{i} 汇总: audio_abs={r.get('audio_abs','无')} audio_dur_us={r.get('audio_duration_us','无')} timeline_dur_us={r.get('duration_us','无')}", file=sys.stderr, flush=True)

    total_duration = timeline_cursor

    lv59_script = _build_lv59_main_script(
        draft_id=draft_id,
        now_us=now_us,
        width=width,
        height=height,
        fps=fps,
        total_duration=total_duration,
        prepared_shots=prepared_shots,
        draft_display_name=draft_folder_name,
        random_transitions=random_transitions,
        random_filters=random_filters,
    )

    # 剪映 5.9 mac：主时间线读根目录 draft_info.json（materials + tracks），与 draft_content.json 同构
    root_info_path = os.path.join(draft_folder, "draft_info.json")
    content_path = os.path.join(draft_folder, "draft_content.json")
    with open(root_info_path, "w", encoding="utf-8") as f:
        json.dump(lv59_script, f, ensure_ascii=False, indent=2)
    with open(content_path, "w", encoding="utf-8") as f:
        json.dump(lv59_script, f, ensure_ascii=False, indent=2)

    materials_count = len(lv59_script.get("materials", {}).get("videos", [])) + len(
        lv59_script.get("materials", {}).get("audios", [])
    )

    # ---- draft_meta_info.json ----
    meta_info = {
        "draft_id": draft_id,
        "draft_name": draft_folder_name,
        "category_id": "",
        "create_time": now_us,
        "update_time": now_us,
        "duration": total_duration,
        "cover_path": "draft_cover.png",
        "video_category": "",
        "local_category": [],
        "tags": [],
        # 以下为剪映识别草稿所需的完整字段
        "draft_root_path": output_dir,
        "draft_fold_path": draft_folder,
        "draft_cover": "draft_cover.png",
        "draft_type": "",
        "draft_need_rename_folder": False,
        "draft_new_version": "",
        "draft_is_from_deeplink": "false",
        "draft_cloud_last_action_download": False,
        "draft_is_invisible": False,
        "draft_is_ae_produce": False,
        "draft_is_web_article_video": False,
        "draft_web_article_video_enter_from": "",
        "draft_is_article_video_draft": False,
        "draft_removable_storage_device": "",
        "draft_deeplink_url": "",
        "draft_is_cloud_temp_draft": False,
        "draft_cloud_template_id": "",
        "draft_is_ai_packaging_used": False,
        "draft_is_ai_translate": False,
        "draft_is_ai_shorts": False,
        "draft_cloud_capcut_purchase_info": "",
        "draft_cloud_purchase_info": "",
        "draft_cloud_videocut_purchase_info": "",
        "draft_cloud_tutorial_info": "",
        "draft_cloud_package_type": "",
        "draft_cloud_draft_sync": False,
        "draft_cloud_draft_cover": False,
        "draft_cloud_package_completed_time": "",
        "draft_enterprise_info": {
            "draft_enterprise_id": "",
            "draft_enterprise_name": "",
            "draft_enterprise_extra": "",
            "enterprise_material": [],
        },
        # tm_duration 与 draft_content.duration 一致，单位为微秒（此前误除以 1000，列表会显示约 1 秒且草稿异常）
        "tm_draft_create": now_us,
        "tm_draft_modified": now_us,
        "tm_draft_removed": 0,
        "tm_draft_cloud_user_id": -1,
        "tm_draft_cloud_space_id": -1,
        "tm_draft_cloud_parent_entry_id": -1,
        "tm_draft_cloud_entry_id": -1,
        "tm_draft_cloud_modified": 0,
        "tm_duration": total_duration,
        "draft_timeline_materials_size": 0,
        "draft_segment_extra_info": [],
        "draft_materials": [],
        "draft_materials_copied_info": [],
        "draft_local_timezone": "Asia/Shanghai",
    }
    meta_path = os.path.join(draft_folder, "draft_meta_info.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta_info, f, ensure_ascii=False, indent=2)

    # ---- draft_settings（INI 格式）----
    draft_settings_path = os.path.join(draft_folder, "draft_settings")
    with open(draft_settings_path, "w", encoding="utf-8") as f:
        f.write("[General]\n")
        f.write(f"cloud_last_modify_platform=mac\n")
        f.write(f"draft_create_time={int(now_us / 1_000_000)}\n")
        f.write(f"draft_last_edit_time={int(now_us / 1_000_000)}\n")
        f.write(f"real_edit_keys={len(shots)}\n")
        f.write(f"real_edit_seconds={total_duration // 1_000_000}\n")

    # ---- draft_agency_config.json ----
    agency_config_path = os.path.join(draft_folder, "draft_agency_config.json")
    with open(agency_config_path, "w", encoding="utf-8") as f:
        json.dump({}, f)

    # ---- draft_biz_config.json ----
    biz_config_path = os.path.join(draft_folder, "draft_biz_config.json")
    with open(biz_config_path, "w", encoding="utf-8") as f:
        f.write("")

    # ---- draft_virtual_store.json ----
    virtual_store_path = os.path.join(draft_folder, "draft_virtual_store.json")
    with open(virtual_store_path, "w", encoding="utf-8") as f:
        json.dump({}, f)

    # ---- key_value.json ----
    key_value_path = os.path.join(draft_folder, "key_value.json")
    with open(key_value_path, "w", encoding="utf-8") as f:
        json.dump({}, f)

    # ---- performance_opt_info.json ----
    perf_path = os.path.join(draft_folder, "performance_opt_info.json")
    with open(perf_path, "w", encoding="utf-8") as f:
        json.dump({}, f)

    # ---- Timelines/project.json ----
    project_json = {
        "config": {
            "color_space": -1,
            "render_index_track_mode_on": False,
            "use_float_render": False,
        },
        "create_time": now_us,
        "id": draft_id,
        "main_timeline_id": timeline_id,
        "timelines": [
            {
                "create_time": now_us,
                "id": timeline_id,
                "is_marked_delete": False,
                "name": "时间线01",
                "update_time": now_us,
            }
        ],
        "update_time": now_us,
        "version": 0,
    }
    proj_path = os.path.join(draft_folder, "Timelines", "project.json")
    with open(proj_path, "w", encoding="utf-8") as f:
        json.dump(project_json, f, ensure_ascii=False, indent=2)

    # ---- Timelines/<id>/ 目录（与根目录脚本一致，避免部分版本只读子目录）----
    timeline_dir = os.path.join(draft_folder, "Timelines", timeline_id)
    os.makedirs(timeline_dir, exist_ok=True)

    draft_info_path = os.path.join(timeline_dir, "draft_info.json")
    with open(draft_info_path, "w", encoding="utf-8") as f:
        json.dump(lv59_script, f, ensure_ascii=False, indent=2)

    # attachment_editing.json
    attach_edit = {
        "segment_video_config": {},
        "segment_text_config": {},
        "segment_audio_config": {},
    }
    with open(os.path.join(timeline_dir, "attachment_editing.json"), "w", encoding="utf-8") as f:
        json.dump(attach_edit, f, ensure_ascii=False, indent=2)

    # attachment_pc_common.json
    attach_pc = {
        "video": {},
        "text": {},
        "audio": {},
    }
    with open(os.path.join(timeline_dir, "attachment_pc_common.json"), "w", encoding="utf-8") as f:
        json.dump(attach_pc, f, ensure_ascii=False, indent=2)

    # ---- 草稿封面（生成纯色占位图）----
    try:
        _generate_cover(draft_folder, width, height)
    except Exception:
        pass  # 封面可选，失败不影响草稿

    return {
        "draft_id": draft_id,
        "draft_name": draft_folder_name,
        "draft_folder": draft_folder,
        "content_path": content_path,
        "total_duration": total_duration,
        "shots_count": len(shots),
        "materials_count": materials_count,
        "platform": "macOS",
    }


# ---- 统一导出入口 ----

def batch_export(
    draft_name: str,
    shots: list,
    resolution: str = "1920x1080",
    fps: int = 30,
    output_path: str = None,
    random_transitions: bool = False,
    random_filters: bool = False,
) -> dict:
    """
    跨平台批量导出。
    macOS：下载媒体 + 生成草稿 JSON + 打开剪映。
    Windows：使用 pyJianYingDraft（如可用）。
    """
    system = get_platform()

    # 解析分辨率
    if "x" in resolution:
        w, h = map(int, resolution.split("x"))
    elif resolution == "9:16":
        w, h = 1080, 1920
    elif resolution == "16:9":
        w, h = 1920, 1080
    elif resolution == "1:1":
        w, h = 1080, 1080
    else:
        w, h = 1920, 1080

    result = {
        "platform": system,
        "draft_name": draft_name,
        "shots_count": len(shots),
        "resolution": f"{w}x{h}",
        "fps": fps,
    }

    if system == "Darwin":
        try:
            draft_result = create_draft_on_mac(
                draft_name=draft_name,
                shots=shots,
                output_dir=output_path,
                fps=fps,
                width=w,
                height=h,
                random_transitions=random_transitions,
                random_filters=random_filters,
            )
            result.update(draft_result)

            # 打开剪映
            open_msg = _open_jianying_pro()
            result["open_jianying"] = open_msg

            # 在 Finder 中显示
            try:
                _reveal_in_finder(draft_result["draft_folder"])
                result["reveal_folder"] = "已在 Finder 中显示"
            except Exception:
                result["reveal_folder"] = "Finder 显示失败"

            result["success"] = True
            result["message"] = (
                f"✅ 剪映草稿已生成！\n"
                f"📁 {draft_result['draft_folder']}\n"
                f"📹 {draft_result['shots_count']} 个镜头\n"
                f"🖼 {draft_result.get('materials_count', 0)} 个媒体文件\n"
                f"⏱ {draft_result['total_duration']/1_000_000:.1f}s\n"
                f"{open_msg}\n"
                f"💡 请在剪映中打开该草稿 → 导出视频"
            )
        except Exception as e:
            import traceback
            result["success"] = False
            result["error"] = str(e)
            result["traceback"] = traceback.format_exc()
            result["message"] = f"❌ macOS 草稿生成失败：{e}"

    else:  # Windows
        try:
            from pyJianYingDraft import JianyingController, ExportResolution, ExportFramerate
            if output_path is None:
                output_path = os.path.join(os.path.expanduser("~"), "Videos", "ContentMaster_Exports")
            ctrl = JianyingController()
            ctrl.export_draft(
                draft_name=draft_name,
                output_path=output_path,
                resolution=ExportResolution.RES_1080P if "1080" in resolution else ExportResolution.RES_720P,
                framerate=ExportFramerate.FR_30 if fps == 30 else ExportFramerate.FR_24,
            )
            result["success"] = True
            result["message"] = f"✅ Windows 批量导出完成！\n输出目录：{output_path}"
        except ImportError:
            result["success"] = False
            result["error"] = "pyJianYingDraft 未安装（Windows）"
            result["message"] = "❌ 请在 Windows 上安装 pyJianYingDraft：\npip install pyJianYingDraft"
        except Exception as e:
            result["success"] = False
            result["error"] = str(e)
            result["message"] = f"❌ Windows 导出失败：{e}"

    return result


# ---- 命令行调试入口 ----
if __name__ == "__main__":
    import argparse, sys as _sys
    parser = argparse.ArgumentParser(description="剪映草稿导出工具")
    parser.add_argument("--list", action="store_true", help="列出所有草稿")
    parser.add_argument("--list-json", action="store_true", help="列出所有草稿（JSON）")
    parser.add_argument("--name", type=str, default="测试草稿", help="草稿名称")
    parser.add_argument("--shots", type=str, default="[]", help="镜头 JSON（命令行参数方式）")
    parser.add_argument("--shots-json-stdin", action="store_true", help="镜头 JSON 从 stdin 读取（避免 E2BIG）")
    parser.add_argument("--resolution", type=str, default="1920x1080")
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--output", type=str, default=None)
    args = parser.parse_args()

    if args.list_json:
        print(json.dumps({"error": "list_drafts 需要完全磁盘访问权限"}, ensure_ascii=False))
    elif args.list:
        print("list_drafts 需要完全磁盘访问权限")
    else:
        # stdin 方式优先（大数据时避免 E2BIG）
        if args.shots_json_stdin:
            stdin_raw = _sys.stdin.read()
            stdin_data = json.loads(stdin_raw)
            shots = stdin_data.get("shots", [])
            output_path = stdin_data.get("outputPath") or args.output
            rnd_tr = bool(stdin_data.get("randomTransitions"))
            rnd_fx = bool(stdin_data.get("randomVideoEffects"))
        else:
            shots = json.loads(args.shots)
            output_path = args.output
            rnd_tr = rnd_fx = False
        result = batch_export(
            draft_name=args.name,
            shots=shots,
            resolution=args.resolution,
            fps=args.fps,
            output_path=output_path,
            random_transitions=rnd_tr,
            random_filters=rnd_fx,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
