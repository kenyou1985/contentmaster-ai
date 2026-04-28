#!/usr/bin/env python3
"""
合并多个剪映草稿目录成一个完整的草稿
用法：
  python merge_drafts.py --name "草稿名称" --output merged.zip --resolution 1920x1080 --fps 30 folder1 folder2 ...
"""
import argparse
import os
import sys
import json
import shutil
import zipfile
import re
from pathlib import Path


def _make_id():
    """生成随机 ID"""
    import random
    return ''.join(random.choices('0123456789abcdefghijklmnopqrstuvwxyz', k=24))


def _timestamp_us():
    """当前时间戳（微秒）"""
    import time
    return int(time.time() * 1_000_000)


def _safe_name(name: str) -> str:
    """生成安全的文件夹名"""
    return "".join(c for c in name if c not in '/\\:*?"<>|').strip() or "合并草稿"


def _deep_copy(obj):
    """深拷贝 JSON 对象"""
    return json.loads(json.dumps(obj))


def _rebase_segment_ids(segment: dict, mat_id_map: dict, new_seg_id: str) -> dict:
    """
    复制一个 segment，重新生成 ID，替换 material_id。
    target_start 保持不变（调用方负责加 offset）。
    """
    seg = _deep_copy(segment)
    seg["id"] = new_seg_id
    # 替换 material_id
    old_mat_id = seg.get("material_id") or seg.get("material_source_id", "")
    if old_mat_id in mat_id_map:
        seg["material_id"] = mat_id_map[old_mat_id]
    # 替换 extra_material_refs 中的 ID
    extra_refs = seg.get("extra_material_refs") or []
    new_extra = []
    for ref in extra_refs:
        if ref in mat_id_map:
            new_extra.append(mat_id_map[ref])
        else:
            new_extra.append(ref)
    seg["extra_material_refs"] = new_extra
    return seg


def _collect_timeline_dir(folder: Path):
    """从 draft folder 中找到实际的 timeline 子目录"""
    timeline_dir = folder / "Timelines"
    if not timeline_dir.exists():
        return None
    for td in timeline_dir.iterdir():
        if td.is_dir() and td.name != "project.json":
            return td
    return None


def merge_drafts(draft_name, output_zip, draft_folders, resolution="1920x1080", fps=30):
    """
    合并多个剪映草稿目录成一个完整的剪映草稿 ZIP。
    核心逻辑：
      1. 从每个 batch 的 draft_content.json 提取视频/音频/字幕 segments，
         累加 target_start 时间偏移，保留完整的音频轨道。
      2. 收集所有 materials（images/audios/videos/texts/transitions 等），
         重新映射 material_id，避免 ID 冲突。
      3. 生成完整的 merged draft_content.json，写入所有轨道和 materials。
    """
    draft_folders = [Path(p) for p in draft_folders]

    # 验证所有目录都存在
    for folder in draft_folders:
        if not folder.exists():
            raise FileNotFoundError(f'草稿目录不存在: {folder}')

    # 解析分辨率
    if "x" in resolution:
        width, height = map(int, resolution.split("x"))
    else:
        width, height = 1920, 1080

    # 创建输出目录
    output_path = Path(output_zip)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # 创建临时合并目录
    import tempfile
    import uuid
    temp_dir = Path(tempfile.gettempdir()) / f"merge_{uuid.uuid4().hex[:8]}"
    temp_dir.mkdir(parents=True, exist_ok=True)

    try:
        # ── 阶段 1：收集所有内容 ────────────────────────────────────────────────
        all_video_segments = []
        all_audio_segments = []
        all_text_segments = []

        # materials 按类型分桶（最终写入 draft_content.materials）
        merged_materials: dict[str, list] = {
            "videos": [], "images": [], "audios": [], "texts": [],
            "transitions": [], "filters": [], "video_effects": [],
            "material_animations": [], "speeds": [], "beats": [],
            "sound_channel_mappings": [], "vocal_separations": [],
            "canvases": [], "stickers": [], "audio_effects": [],
            "audio_fades": [], "audio_balances": [],
        }
        # ID 映射：旧 material_id → 新 material_id（避免不同 batch 间 ID 冲突）
        mat_id_map: dict[str, str] = {}

        timeline_cursor = 0  # 微秒累积
        total_duration = 0

        for folder in draft_folders:
            timeline_dir = _collect_timeline_dir(folder)
            if not timeline_dir:
                print(f"[merge] 跳过无 timeline 目录: {folder}", file=sys.stderr)
                continue

            content_path = timeline_dir / "draft_content.json"
            if not content_path.exists():
                print(f"[merge] 跳过无 draft_content.json: {folder}", file=sys.stderr)
                continue

            with open(content_path, 'r', encoding='utf-8') as f:
                content = json.load(f)

            tracks = content.get("tracks") or []
            mats = content.get("materials") or {}

            # ── 1a. 收集 materials ───────────────────────────────────────────────
            # videos / images / audios / texts 整体迁移（去重）
            existing_ids = set()
            for m_list in merged_materials.values():
                for m in m_list:
                    existing_ids.add(m.get("id", ""))

            for mat_type in ["videos", "images", "audios", "texts"]:
                for mat in mats.get(mat_type, []):
                    old_id = mat.get("id", "")
                    if not old_id or old_id in existing_ids:
                        continue
                    new_id = _make_id()
                    mat_id_map[old_id] = new_id
                    mat_copy = _deep_copy(mat)
                    mat_copy["id"] = new_id
                    merged_materials.setdefault(mat_type, []).append(mat_copy)
                    existing_ids.add(new_id)

            # transitions / filters / video_effects / material_animations 等按 ID 去重
            for mat_type in ["transitions", "filters", "video_effects",
                              "material_animations", "speeds", "beats",
                              "sound_channel_mappings", "vocal_separations",
                              "canvases", "stickers", "audio_effects",
                              "audio_fades", "audio_balances"]:
                for mat in mats.get(mat_type, []):
                    old_id = mat.get("id", "")
                    if not old_id:
                        continue
                    if old_id in existing_ids:
                        continue
                    new_id = _make_id()
                    mat_id_map[old_id] = new_id
                    mat_copy = _deep_copy(mat)
                    mat_copy["id"] = new_id
                    merged_materials.setdefault(mat_type, []).append(mat_copy)
                    existing_ids.add(new_id)

            # ── 1b. 收集 tracks ────────────────────────────────────────────────
            for track in tracks:
                track_type = track.get("type")   # 0=视频, 1=音频, 2=字幕/文字
                track_id = track.get("id") or _make_id()
                segments = track.get("segments") or []

                if not segments:
                    continue

                # 计算本轨道所有 segment 的总时长（用于累加 timeline_cursor）
                track_total_dur = 0

                for seg in segments:
                    new_seg_id = _make_id()

                    # 处理 segment
                    seg_copy = _deep_copy(seg)
                    seg_id = seg_copy.get("id") or _make_id()
                    seg_copy["id"] = new_seg_id

                    # 累加 target_start 偏移（只在第一个 batch 时从 0 开始）
                    target_start = int(seg_copy.get("target_start", 0) or 0)
                    seg_copy["target_start"] = target_start + timeline_cursor

                    # 替换 material_id
                    old_mat_id = seg_copy.get("material_id") or ""
                    if old_mat_id in mat_id_map:
                        seg_copy["material_id"] = mat_id_map[old_mat_id]

                    # 替换 extra_material_refs
                    old_extra = seg_copy.get("extra_material_refs") or []
                    new_extra = []
                    for ref in old_extra:
                        if ref in mat_id_map:
                            new_extra.append(mat_id_map[ref])
                        else:
                            new_extra.append(ref)
                    seg_copy["extra_material_refs"] = new_extra

                    # 更新 track_id（合并后需要新 ID）
                    seg_copy["track_id"] = track_id

                    # 统计时长
                    dur = int(seg_copy.get("duration", 0) or 0)
                    track_total_dur = max(track_total_dur, seg_copy["target_start"] + dur)

                    # 按轨道类型收集
                    if track_type == 0:
                        all_video_segments.append(seg_copy)
                    elif track_type == 1:
                        all_audio_segments.append(seg_copy)
                    elif track_type == 2:
                        all_text_segments.append(seg_copy)

                # 所有轨道中最长的那个决定 timeline_cursor 前进多少
                timeline_cursor = max(timeline_cursor, track_total_dur)
                total_duration = max(total_duration, track_total_dur)

        # 按 target_start 排序（确保各轨道内部顺序正确）
        for seg_list in [all_video_segments, all_audio_segments, all_text_segments]:
            seg_list.sort(key=lambda s: s.get("target_start", 0))

        # ── 阶段 2：构建合并后的目录结构 ──────────────────────────────────────
        safe_draft_name = _safe_name(draft_name)
        merged_draft = temp_dir / safe_draft_name
        merged_draft.mkdir(parents=True, exist_ok=True)

        # 创建所有必需目录
        for subdir in [
            "Timelines", "Resources",
            "Resources/image", "Resources/audio", "Resources/video",
            "Resources/videoAlg", "Resources/audioAlg",
            "Resources/digitalHuman", "Resources/restore_lut",
            "Resources/broll", "Resources/broll/default",
            "Resources/text", "adjust_mask", "matting",
            "qr_upload", "smart_crop", "subdraft",
            "common_attachment",
        ]:
            os.makedirs(merged_draft / subdir, exist_ok=True)

        # ── 阶段 3：复制所有媒体资源文件 ───────────────────────────────────────
        for folder in draft_folders:
            resources_dir = folder / "Resources"
            if not resources_dir.exists():
                continue
            for src_dir in ['image', 'audio', 'video']:
                src = resources_dir / src_dir
                if not src.exists():
                    continue
                for f in src.iterdir():
                    if f.is_file():
                        dst = merged_draft / "Resources" / src_dir / f.name
                        if not dst.exists():
                            shutil.copy2(f, dst)

        # ── 阶段 4：生成 draft_content.json ─────────────────────────────────────
        draft_id = _make_id()
        now_us = _timestamp_us()
        timeline_id = _make_id()

        video_track_id = _make_id()
        audio_track_id = _make_id()
        text_track_id = _make_id()

        # 为所有音频 segments 设置 track_id
        for seg in all_audio_segments:
            seg["track_id"] = audio_track_id
        for seg in all_text_segments:
            seg["track_id"] = text_track_id

        # 轨道列表（按优先级：视频 → 音频 → 字幕）
        tracks_out = []
        if all_video_segments:
            tracks_out.append({
                "id": video_track_id,
                "type": 0,
                "name": "视频轨",
                "segments": all_video_segments,
                "height": 0,
                "width": 0,
            })
        if all_audio_segments:
            tracks_out.append({
                "id": audio_track_id,
                "type": 1,
                "name": "音频轨",
                "segments": all_audio_segments,
                "height": 0,
                "width": 0,
            })
        if all_text_segments:
            tracks_out.append({
                "id": text_track_id,
                "type": 2,
                "name": "字幕",
                "segments": all_text_segments,
                "height": 0,
                "width": 0,
            })

        draft_content = {
            "canvas_config": {
                "height": height,
                "ratio": "original",
                "width": width,
            },
            "color_space": 0,
            "config": {
                "adjust_max_index": 1,
                "attachment_info": [],
                "combination_max_index": 1,
                "export_range": None,
                "extract_audio_last_index": 1,
                "maintrack_adsorb": True,
                "material_save_mode": 0,
                "multi_language_current": "none",
                "multi_language_list": [],
                "multi_language_main": "none",
                "multi_language_mode": "none",
                "o3ics_recognition_id": "",
                "o3ics_sync": True,
                "o3ics_taskinfo": [],
                "original_sound_last_index": 1,
                "record_audio_last_index": 1,
                "sticker_max_index": 1,
                "subtitle_keywords_config": None,
                "subtitle_recognition_id": "",
                "subtitle_sync": True,
                "subtitle_taskinfo": [],
                "system_font_list": [],
                "video_mute": False,
                "zoom_info_params": None,
            },
            "cover": None,
            "create_time": now_us,
            "duration": total_duration,
            "extra_info": None,
            "fps": float(fps),
            "free_render_index_mode_on": False,
            "group_container": None,
            "id": draft_id,
            "keyframe_graph_list": [],
            "keyframes": {
                "adjusts": [], "audios": [], "effects": [],
                "filters": [], "handwrites": [],
                "stickers": [], "texts": [],
                "videos": [],
            },
            "last_modified_platform": {
                "app_id": 3704,
                "app_source": "lv",
                "app_version": "5.9.0",
                "os": "mac",
            },
            "platform": {
                "app_id": 3704,
                "app_source": "lv",
                "app_version": "5.9.0",
                "os": "mac",
            },
            "materials": merged_materials,
            "mutable_config": None,
            "name": safe_draft_name,
            "new_version": "110.0.0",
            "relationships": [],
            "render_index_track_mode_on": False,
            "retouch_cover": None,
            "source": "default",
            "static_cover_image_path": "",
            "time_marks": None,
            "tracks": tracks_out,
            "update_time": now_us,
            "version": 360000,
        }

        # 写入 merged draft_content.json
        merged_timeline_dir = merged_draft / "Timelines" / timeline_id
        merged_timeline_dir.mkdir(parents=True, exist_ok=True)
        content_out_path = merged_timeline_dir / "draft_content.json"
        with open(content_out_path, 'w', encoding='utf-8') as f:
            json.dump(draft_content, f, ensure_ascii=False, indent=2)

        # ── 阶段 5：生成 Timelines/project.json ──────────────────────────────────
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
        proj_path = merged_draft / "Timelines" / "project.json"
        with open(proj_path, 'w', encoding='utf-8') as f:
            json.dump(project_json, f, ensure_ascii=False, indent=2)

        # ── 阶段 6：生成 draft_info.json（与 draft_content 同构，兜底用）──────
        # 剪映专业版 macOS 主要读 draft_content.json，draft_info.json 主要给移动端用
        draft_info = _deep_copy(draft_content)
        # draft_info 中用 target_start 而非 start_us
        for track in draft_info.get("tracks", []):
            for seg in track.get("segments", []):
                if "target_start" in seg:
                    seg["target_start_us"] = seg["target_start"]
                if "duration" in seg:
                    seg["duration_us"] = seg["duration"]

        draft_info_out = {
            "config": {
                "video_width": width,
                "video_height": height,
                "video_fps": float(fps),
                "align_time": 0,
                "draft_mode": 0,
            },
            "content": {
                "segments": all_video_segments,  # draft_info 只用视频 segments
            },
        }
        draft_info_path = merged_timeline_dir / "draft_info.json"
        with open(draft_info_path, 'w', encoding='utf-8') as f:
            json.dump(draft_info_out, f, ensure_ascii=False, indent=2)

        # ── 阶段 7：生成 draft_meta_info.json ───────────────────────────────────
        meta_info = {
            "draft_id": draft_id,
            "draft_name": safe_draft_name,
            "category_id": -1,
            "description": "",
            "create_time": now_us,
            "update_time": now_us,
            "duration": total_duration,
            "video_height": height,
            "video_width": width,
            "video_fps": float(fps),
            "draft_type": 0,
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
        meta_path = merged_draft / "draft_meta_info.json"
        with open(meta_path, 'w', encoding='utf-8') as f:
            json.dump(meta_info, f, ensure_ascii=False, indent=2)

        # ── 阶段 8：生成其他必需文件 ────────────────────────────────────────────
        with open(merged_draft / "draft_settings", 'w', encoding='utf-8') as f:
            f.write("[General]\n")
            f.write(f"cloud_last_modify_platform=mac\n")
            f.write(f"draft_create_time={int(now_us / 1_000_000)}\n")
            f.write(f"draft_last_edit_time={int(now_us / 1_000_000)}\n")
            f.write(f"real_edit_keys={len(all_video_segments)}\n")
            f.write(f"real_edit_seconds={total_duration // 1_000_000}\n")

        for fname, content in [
            ("draft_agency_config.json", {}),
            ("draft_virtual_store.json", {}),
            ("key_value.json", {}),
            ("performance_opt_info.json", {}),
        ]:
            with open(merged_draft / fname, 'w', encoding='utf-8') as f:
                json.dump(content, f)

        # attachment_editing.json
        attach_edit = {
            "segment_video_config": {},
            "segment_text_config": {},
            "segment_audio_config": {},
        }
        with open(merged_timeline_dir / "attachment_editing.json", 'w', encoding='utf-8') as f:
            json.dump(attach_edit, f, ensure_ascii=False, indent=2)

        # attachment_pc_common.json
        attach_pc = {"video": {}, "text": {}, "audio": {}}
        with open(merged_timeline_dir / "attachment_pc_common.json", 'w', encoding='utf-8') as f:
            json.dump(attach_pc, f, ensure_ascii=False, indent=2)

        # ── 阶段 9：打包成 ZIP ──────────────────────────────────────────────────
        if output_path.exists():
            output_path.unlink()

        with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(merged_draft):
                for file in files:
                    file_path = Path(root) / file
                    arcname = file_path.relative_to(merged_draft)
                    zf.write(file_path, arcname)

        zip_size = output_path.stat().st_size / (1024 * 1024)
        print(f"合并完成: {output_path}", file=sys.stderr)
        print(f"  视频轨道: {len(all_video_segments)} segments", file=sys.stderr)
        print(f"  音频轨道: {len(all_audio_segments)} segments", file=sys.stderr)
        print(f"  字幕轨道: {len(all_text_segments)} segments", file=sys.stderr)
        print(f"  总时长: {total_duration / 1_000_000:.1f}s", file=sys.stderr)
        print(f"  ZIP 大小: {zip_size:.1f}MB", file=sys.stderr)

        return {
            "success": True,
            "merged_zip": str(output_path),
            "video_segments": len(all_video_segments),
            "audio_segments": len(all_audio_segments),
            "text_segments": len(all_text_segments),
            "total_duration_sec": round(total_duration / 1_000_000, 2),
            "zip_size_mb": round(zip_size, 2),
        }

    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description='合并多个剪映草稿目录')
    parser.add_argument('--name', required=True, help='合并后的草稿名称')
    parser.add_argument('--output', required=True, help='输出的 ZIP 文件名')
    parser.add_argument('--resolution', default='1920x1080', help='分辨率')
    parser.add_argument('--fps', type=int, default=30, help='帧率')
    parser.add_argument('draft_folders', nargs='+', help='要合并的草稿目录')

    args = parser.parse_args()

    try:
        result = merge_drafts(
            draft_name=args.name,
            output_zip=args.output,
            draft_folders=args.draft_folders,
            resolution=args.resolution,
            fps=args.fps,
        )
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as e:
        print(f"合并失败: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return 1


if __name__ == '__main__':
    sys.exit(main())
