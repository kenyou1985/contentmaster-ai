#!/usr/bin/env python3
"""
合并多个 ZIP 文件为一个（保留内部目录结构）
用法：
  python merge_zips.py --output merged.zip part1.zip part2.zip ...
"""
import argparse
import os
import sys
import zipfile
from pathlib import Path


def merge_zips(output_path, input_paths):
    """
    合并多个 ZIP 文件。
    策略：
    - 所有 ZIP 内部都有相同的子目录结构（如 draft_content/、draft/ 等）
    - 合并后保留各自子目录，避免文件冲突
    """
    output_path = Path(output_path)
    if output_path.exists():
        output_path.unlink()

    seen_names = set()

    with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as out_zip:
        for zip_path in input_paths:
            zip_path = Path(zip_path)
            if not zip_path.exists():
                raise FileNotFoundError(f'ZIP 不存在: {zip_path}')

            with zipfile.ZipFile(zip_path, 'r') as in_zip:
                for info in in_zip.infolist():
                    # 如果是目录，保留
                    if info.is_dir():
                        out_zip.writestr(info, in_zip.read(info.filename))
                        continue

                    # 如果是文件，重命名避免冲突（添加批次后缀）
                    original_name = info.filename
                    # 提取目录 + 文件名
                    dir_part = os.path.dirname(original_name)
                    base_name = os.path.basename(original_name)

                    # 保留原名，冲突则添加序号
                    final_name = original_name
                    counter = 1
                    while final_name in seen_names:
                        name_no_ext, ext = os.path.splitext(base_name)
                        final_name = os.path.join(dir_part, f'{name_no_ext}_batch{counter}{ext}')
                        counter += 1

                    seen_names.add(final_name)
                    data = in_zip.read(info.filename)
                    out_zip.writestr(final_name, data)

    print(f'✅ 合并完成: {output_path} ({len(input_paths)} 个 ZIP → {len(seen_names)} 个文件)')


def main():
    parser = argparse.ArgumentParser(description='合并多个剪映 ZIP 文件')
    parser.add_argument('--output', required=True, help='合并后的 ZIP 文件名')
    parser.add_argument('zips', nargs='+', help='要合并的 ZIP 文件路径')

    args = parser.parse_args()

    try:
        merge_zips(args.output, args.zips)
        print(f'✅ 合并成功: {args.output}')
        return 0
    except Exception as e:
        print(f'❌ 合并失败: {e}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
