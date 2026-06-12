import json
from pathlib import Path

paths_to_try = [
    Path('graphify-out/.graphify_detect.json'),
    Path('.graphify_detect.json')
]

data = None
for p in paths_to_try:
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding='utf-8'))
            break
        except Exception:
            try:
                data = json.loads(p.read_text(encoding='utf-16'))
                break
            except Exception:
                pass

if data:
    print(f"Corpus: {data['total_files']} files · ~{data['total_words']} words")
    files = data.get('files', {})
    for cat, list_files in files.items():
        if list_files:
            print(f"  {cat}:     {len(list_files)} files")
else:
    print("Could not find or read .graphify_detect.json in graphify-out/ or root.")

