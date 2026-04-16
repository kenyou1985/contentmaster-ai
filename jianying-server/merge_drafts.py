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
from pathlib import Path


def _make_id():
    """生成随机 ID"""
    import random
    return ''.join(random.choices('0123456789abcdefghijklmnopqrstuvwxyz', k=24))


def _timestamp_us():
    """当前时间戳（微秒）"""
    import time
    return int(time.time() * 1_000_000)


def merge_drafts(draft_name, output_zip, draft_folders, resolution="1920x1080", fps=30):
    """
    合并多个草稿目录成一个完整的剪映草稿 ZIP
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
        # 收集所有资源文件（图片、音频、视频）
        all_resources = {
            'image': {},
            'audio': {},
            'video': {},
        }
        
        all_shots = []  # 收集所有镜头的时间线数据
        timeline_cursor = 0
        total_duration = 0
        materials_count = 0
        
        for folder in draft_folders:
            # 读取该批次的 Resources 目录
            resources_dir = folder / "Resources"
            if resources_dir.exists():
                # 收集图片
                image_dir = resources_dir / "image"
                if image_dir.exists():
                    for f in image_dir.iterdir():
                        if f.is_file():
                            rel_path = f"Resources/image/{f.name}"
                            all_resources['image'][f.name] = rel_path
                
                # 收集音频
                audio_dir = resources_dir / "audio"
                if audio_dir.exists():
                    for f in audio_dir.iterdir():
                        if f.is_file():
                            rel_path = f"Resources/audio/{f.name}"
                            all_resources['audio'][f.name] = rel_path
                
                # 收集视频
                video_dir = resources_dir / "video"
                if video_dir.exists():
                    for f in video_dir.iterdir():
                        if f.is_file():
                            rel_path = f"Resources/video/{f.name}"
                            all_resources['video'][f.name] = rel_path
            
            # 读取该批次的 draft_content.json
            timeline_dir = None
            for td in (folder / "Timelines").iterdir() if (folder / "Timelines").exists() else []:
                if td.is_dir() and td.name != "project.json":
                    timeline_dir = td
                    break
            
            if timeline_dir:
                draft_info_path = timeline_dir / "draft_info.json"
                if draft_info_path.exists():
                    with open(draft_info_path, 'r', encoding='utf-8') as f:
                        draft_info = json.load(f)
                    
                    # 提取 segments 并累加时间线偏移
                    segments = draft_info.get('content', {}).get('segments', [])
                    for seg in segments:
                        # 更新时间线偏移
                        start_us = seg.get('target_start', 0) + timeline_cursor
                        seg['target_start'] = start_us
                        seg['clip_start'] = seg.get('clip_start', 0)
                        seg['source_start'] = seg.get('source_start', 0)
                        all_shots.append(seg)
                        
                        # 更新时长统计
                        dur = seg.get('duration', 5 * 1_000_000)
                        timeline_cursor += dur
                        total_duration = max(total_duration, start_us + dur)
                        materials_count += 1
        
        # 创建合并后的草稿目录
        safe_name = "".join(c for c in draft_name if c not in '/\\:*?"<>|').strip() or "合并草稿"
        merged_draft = temp_dir / safe_name
        merged_draft.mkdir(parents=True, exist_ok=True)
        
        # 创建所有必需目录
        os.makedirs(merged_draft / "Timelines", exist_ok=True)
        os.makedirs(merged_draft / "Resources", exist_ok=True)
        os.makedirs(merged_draft / "Resources/image", exist_ok=True)
        os.makedirs(merged_draft / "Resources/audio", exist_ok=True)
        os.makedirs(merged_draft / "Resources/video", exist_ok=True)
        os.makedirs(merged_draft / "Resources/videoAlg", exist_ok=True)
        os.makedirs(merged_draft / "Resources/audioAlg", exist_ok=True)
        os.makedirs(merged_draft / "Resources/digitalHuman", exist_ok=True)
        os.makedirs(merged_draft / "Resources/restore_lut", exist_ok=True)
        os.makedirs(merged_draft / "Resources/broll", exist_ok=True)
        os.makedirs(merged_draft / "Resources/broll/default", exist_ok=True)
        os.makedirs(merged_draft / "Resources/text", exist_ok=True)
        os.makedirs(merged_draft / "adjust_mask", exist_ok=True)
        os.makedirs(merged_draft / "matting", exist_ok=True)
        os.makedirs(merged_draft / "qr_upload", exist_ok=True)
        os.makedirs(merged_draft / "smart_crop", exist_ok=True)
        os.makedirs(merged_draft / "subdraft", exist_ok=True)
        os.makedirs(merged_draft / "common_attachment", exist_ok=True)
        
        # 复制所有资源文件
        for folder in draft_folders:
            resources_dir = folder / "Resources"
            if resources_dir.exists():
                for src_dir in ['image', 'audio', 'video']:
                    src = resources_dir / src_dir
                    if src.exists():
                        for f in src.iterdir():
                            if f.is_file():
                                dst = merged_draft / "Resources" / src_dir / f.name
                                if not dst.exists():
                                    shutil.copy2(f, dst)
        
        # 生成 draft_content.json（剪映 5.9 格式）
        draft_id = _make_id()
        now_us = _timestamp_us()
        timeline_id = _make_id()
        
        # 生成视频轨道
        video_segments = []
        audio_segments = []
        
        for seg in all_shots:
            video_segments.append({
                "id": _make_id(),
                "type": 0,
                "target_start": seg.get('target_start', 0),
                "duration": seg.get('duration', 5 * 1_000_000),
                "clip_start": seg.get('clip_start', 0),
                "source_start": seg.get('source_start', 0),
                "media_info": seg.get('media_info', {}),
                "extra_info": {},
            })
            audio_segments.append({
                "id": _make_id(),
                "type": 1,
                "target_start": seg.get('target_start', 0),
                "duration": seg.get('duration', 5 * 1_000_000),
                "clip_start": seg.get('clip_start', 0),
                "source_start": seg.get('source_start', 0),
                "media_info": seg.get('media_info', {}),
                "extra_info": {},
            })
        
        content = {
            "materials": {
                "videos": [],
                "images": [],
                "audios": [],
                "video_list": [],
            },
            "tracks": [
                {
                    "id": _make_id(),
                    "type": 0,  # 视频轨道
                    "name": "视频轨",
                    "segments": video_segments,
                },
                {
                    "id": _make_id(),
                    "type": 1,  # 音频轨道
                    "name": "音频轨",
                    "segments": audio_segments,
                },
            ],
        }
        
        # 生成 Timelines/project.json
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
        
        # 生成 Timelines/<id>/draft_info.json
        timeline_dir = merged_draft / "Timelines" / timeline_id
        os.makedirs(timeline_dir, exist_ok=True)
        
        lv59_script = {
            "config": {
                "video_width": width,
                "video_height": height,
                "video_fps": fps,
                "align_time": 0,
                "draft_mode": 0,
            },
            "content": {
                "segments": all_shots,
            },
        }
        
        draft_info_path = timeline_dir / "draft_info.json"
        with open(draft_info_path, 'w', encoding='utf-8') as f:
            json.dump(lv59_script, f, ensure_ascii=False, indent=2)
        
        # 生成 draft_meta_info.json
        meta_info = {
            "draft_id": draft_id,
            "draft_name": safe_name,
            "category_id": -1,
            "description": "",
            "create_time": now_us,
            "update_time": now_us,
            "duration": total_duration,
            "video_height": height,
            "video_width": width,
            "video_fps": fps,
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
        
        # 生成其他必需文件
        with open(merged_draft / "draft_settings", 'w', encoding='utf-8') as f:
            f.write("[General]\n")
            f.write(f"cloud_last_modify_platform=mac\n")
            f.write(f"draft_create_time={int(now_us / 1_000_000)}\n")
            f.write(f"draft_last_edit_time={int(now_us / 1_000_000)}\n")
            f.write(f"real_edit_keys={len(all_shots)}\n")
            f.write(f"real_edit_seconds={total_duration // 1_000_000}\n")
        
        with open(merged_draft / "draft_agency_config.json", 'w', encoding='utf-8') as f:
            json.dump({}, f)
        
        with open(merged_draft / "draft_biz_config.json", 'w', encoding='utf-8') as f:
            f.write("")
        
        with open(merged_draft / "draft_virtual_store.json", 'w', encoding='utf-8') as f:
            json.dump({}, f)
        
        with open(merged_draft / "key_value.json", 'w', encoding='utf-8') as f:
            json.dump({}, f)
        
        with open(merged_draft / "performance_opt_info.json", 'w', encoding='utf-8') as f:
            json.dump({}, f)
        
        # 生成 attachment_editing.json
        attach_edit = {
            "segment_video_config": {},
            "segment_text_config": {},
            "segment_audio_config": {},
        }
        with open(timeline_dir / "attachment_editing.json", 'w', encoding='utf-8') as f:
            json.dump(attach_edit, f, ensure_ascii=False, indent=2)
        
        # 生成 attachment_pc_common.json
        attach_pc = {
            "video": {},
            "text": {},
            "audio": {},
        }
        with open(timeline_dir / "attachment_pc_common.json", 'w', encoding='utf-8') as f:
            json.dump(attach_pc, f, ensure_ascii=False, indent=2)
        
        # 打包成 ZIP
        print(f"合并完成，开始打包 ZIP...")
        
        # 删除旧的 ZIP（如果存在）
        if output_path.exists():
            output_path.unlink()
        
        with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(merged_draft):
                for file in files:
                    file_path = Path(root) / file
                    arcname = file_path.relative_to(merged_draft)
                    zf.write(file_path, arcname)
        
        zip_size = output_path.stat().st_size / (1024 * 1024)
        print(f"✅ 合并完成: {output_path} ({len(draft_folders)} 个草稿 → {len(all_shots)} 个镜头)")
        print(f"   ZIP 大小: {zip_size:.1f}MB")
        
        return {
            "success": True,
            "merged_zip": str(output_path),
            "shots_count": len(all_shots),
            "zip_size_mb": zip_size,
        }
        
    finally:
        # 清理临时目录
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
        print(f"❌ 合并失败: {e}", file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
