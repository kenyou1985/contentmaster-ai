#!/usr/bin/env python3
with open('/Users/kenyou/Desktop/Ai/contentmaster-ai/services/yiJingParallelLongForm.ts', 'r', encoding='utf-8') as f:
    content = f.read()

lines = content.split('\n')
for i, line in enumerate(lines):
    stripped = line
    j = 0
    while j < len(stripped):
        if stripped[j] == '\\' and j + 1 < len(stripped) and stripped[j+1] == '$':
            j += 2
            continue
        if stripped[j] == '$' and j + 1 < len(stripped) and stripped[j+1] == '{':
            if j == 0 or stripped[j-1] != '\\':
                snippet = stripped[j:j+50]
                print(f'Line {i+1}: UNESCAPED ${snippet}')
        j += 1
