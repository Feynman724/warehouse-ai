"""Recheck detections on the supplied training photos; not a generalization test."""
import base64
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import vision  # noqa: E402


def iou(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    overlap = max(0, x2 - x1) * max(0, y2 - y1)
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    return overlap / (area_a + area_b - overlap) if area_a + area_b > overlap else 0


def main():
    matched_total = target_total = 0
    for group in ('train', 'additional'):
        for image in sorted((ROOT / 'training/photos' / group).glob('mixed*.jpg')):
            data = 'data:image/jpeg;base64,' + base64.b64encode(image.read_bytes()).decode()
            found = vision.detect_live(data)['detections']
            truth = []
            label_path = ROOT / 'training/labels' / group / (image.stem + '.txt')
            for line in label_path.read_text().splitlines():
                cls, cx, cy, width, height = map(float, line.split())
                truth.append((vision.SPECIALIST_NAMES[int(cls)],
                              [cx - width / 2, cy - height / 2,
                               cx + width / 2, cy + height / 2]))
            matched = set()
            for candidate in sorted(found, key=lambda item: -item['confidence']):
                scores = [(iou(candidate['box'], box), index)
                          for index, (name, box) in enumerate(truth)
                          if name == candidate['label'] and index not in matched]
                if scores and max(scores)[0] >= .3:
                    matched.add(max(scores)[1])
            print(f'{image.stem}: {len(matched)}/{len(truth)} targets')
            matched_total += len(matched)
            target_total += len(truth)
    print(f'Training-photo check: {matched_total}/{target_total} targets; not an independent test')


if __name__ == '__main__':
    main()
